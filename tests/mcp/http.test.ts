import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AccessAssertionVerifier } from "../../src/auth/access.js";
import { connectClient, type TestClient } from "../helpers/client.js";
import { delay, initializeRawSession, rawMcp, toolCall } from "../helpers/http.js";
import { createJwtFixture, verifierFor, type JwtFixture } from "../helpers/jwt.js";
import { startTestServer, type TestServer } from "../helpers/server.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tmp.js";

let workspace: TempWorkspace;
let fixture: JwtFixture;
let verifier: AccessAssertionVerifier;
let server: TestServer;

beforeAll(async () => {
  workspace = await createTempWorkspace();
  fixture = await createJwtFixture();
  verifier = verifierFor(fixture);
  server = await startTestServer({ verifier, workspaceDir: workspace.dir, issuer: fixture.issuer });
});

afterAll(async () => {
  await server.close();
  await workspace.cleanup();
});

async function token(subject = "user-123"): Promise<string> {
  return fixture.sign({ subject });
}

async function connect(subject = "user-123"): Promise<TestClient> {
  return connectClient(server.baseUrl, await token(subject));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isAlive(pid);
}

async function waitForFile(path: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await delay(25);
  }
  return existsSync(path);
}

async function readPid(file: string): Promise<number> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (existsSync(join(workspace.dir, file))) {
      const text = await readFile(join(workspace.dir, file), "utf-8");
      if (text.trim().length > 0) {
        return Number.parseInt(text.trim(), 10);
      }
    }
    await delay(25);
  }
  throw new Error(`pid file ${file} never appeared`);
}

describe("HTTP surface", () => {
  it("serves /healthz without authentication", async () => {
    const response = await fetch(`${server.baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET /healthz", async () => {
    const response = await fetch(`${server.baseUrl}/healthz`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("returns 404 for unknown paths, including /.well-known/*", async () => {
    expect((await fetch(`${server.baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it("rejects a request without an assertion", async () => {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a malformed assertion", async () => {
    const response = await rawMcp(server.baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      assertion: "not-a-jwt",
    });
    expect(response.status).toBe(401);
  });

  it("rejects an assertion with the wrong audience", async () => {
    const response = await rawMcp(server.baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      assertion: await fixture.sign({ audience: "other" }),
    });
    expect(response.status).toBe(401);
  });

  it("answers 405 for an unsupported method on /mcp", async () => {
    const response = await rawMcp(server.baseUrl, undefined, {
      method: "PUT",
      assertion: await token(),
    });
    expect(response.status).toBe(405);
  });

  it("allows a request with no Origin and rejects an unlisted Origin", async () => {
    const noOrigin = await rawMcp(server.baseUrl, { jsonrpc: "2.0", id: 99, method: "ping" }, {
      assertion: await token(),
    });
    expect(noOrigin.status).not.toBe(403);

    const badOrigin = await rawMcp(server.baseUrl, { jsonrpc: "2.0", id: 99, method: "ping" }, {
      assertion: await token(),
      origin: "https://evil.example.com",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("rejects a Host header that is not the configured domain", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: server.port, path: "/mcp", method: "POST", headers: { host: "evil.example.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("MCP sessions over HTTP", () => {
  it("initializes and lists exactly the four tools", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    } finally {
      await close();
    }
  });

  it("issues a session id and serves each tool over real HTTP", async () => {
    const client = await connect();
    try {
      expect(client.transport.sessionId).toBeTypeOf("string");

      const write = await client.client.callTool({
        name: "write",
        arguments: { path: "hello.txt", content: "hello world" },
      });
      expect(write.isError).toBeFalsy();

      const read = await client.client.callTool({ name: "read", arguments: { path: "hello.txt" } });
      expect(JSON.stringify(read.content)).toContain("hello world");

      const edit = await client.client.callTool({
        name: "edit",
        arguments: { path: "hello.txt", edits: [{ oldText: "world", newText: "there" }] },
      });
      expect(edit.isError).toBeFalsy();

      const bash = await client.client.callTool({
        name: "bash",
        arguments: { command: "cat hello.txt" },
      });
      expect(JSON.stringify(bash.content)).toContain("hello there");
    } finally {
      await client.close();
    }
  });

  it("keeps sessions independent", async () => {
    const first = await connect();
    const second = await connect();
    try {
      expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
      await first.close();
      const { tools } = await second.client.listTools();
      expect(tools).toHaveLength(4);
    } finally {
      await second.close();
    }
  });

  it("rejects a different identity on an existing session", async () => {
    const assertion = await token("owner");
    const session = await initializeRawSession(server.baseUrl, assertion);

    const foreign = await rawMcp(
      server.baseUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { assertion: await token("intruder"), sessionId: session.sessionId },
    );
    expect(foreign.status).toBe(401);
  });

  it("accepts a refreshed token with the same subject", async () => {
    const session = await initializeRawSession(server.baseUrl, await token("owner"));
    const refreshed = await rawMcp(
      server.baseUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { assertion: await token("owner"), sessionId: session.sessionId },
    );
    expect(refreshed.status).toBe(200);
    const result = refreshed.messages[0] as { result?: { tools?: unknown[] } };
    expect(result.result?.tools).toHaveLength(4);
  });

  it("rejects an unknown session id", async () => {
    const response = await rawMcp(
      server.baseUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { assertion: await token(), sessionId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(response.status).toBe(404);
  });

  it("rejects a non-initialize POST without a session id", async () => {
    const response = await rawMcp(
      server.baseUrl,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { assertion: await token() },
    );
    expect(response.status).toBe(400);
  });
});

describe("cancellation scope", () => {
  it("cancels the matching request and leaves another session's identical request id alone", async () => {
    const assertion = await token();
    const sessionA = await initializeRawSession(server.baseUrl, assertion);
    const sessionB = await initializeRawSession(server.baseUrl, assertion);

    // A cancelled request gets no response (its result is unused), so the SSE
    // stream is left open on purpose; observe cancellation through the killed
    // process instead of the HTTP body.
    void rawMcp(
      server.baseUrl,
      toolCall(1, "bash", { command: "sleep 30 & echo $! > pidA.txt; wait" }),
      { assertion, sessionId: sessionA.sessionId },
    ).catch(() => undefined);
    void rawMcp(
      server.baseUrl,
      toolCall(1, "bash", { command: "sleep 30 & echo $! > pidB.txt; wait" }),
      { assertion, sessionId: sessionB.sessionId },
    ).catch(() => undefined);

    const pidA = await readPid("pidA.txt");
    const pidB = await readPid("pidB.txt");

    await rawMcp(
      server.baseUrl,
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "test" } },
      { assertion, sessionId: sessionA.sessionId },
    );

    expect(await waitForPidGone(pidA)).toBe(true);
    // The same request id in another session is unaffected.
    expect(isAlive(pidB)).toBe(true);

    await rawMcp(server.baseUrl, undefined, { method: "DELETE", sessionId: sessionA.sessionId, assertion });
    await rawMcp(server.baseUrl, undefined, { method: "DELETE", sessionId: sessionB.sessionId, assertion });
    expect(await waitForPidGone(pidB)).toBe(true);
  });

  it("DELETE cancels only that session's work", async () => {
    const assertion = await token();
    const sessionA = await initializeRawSession(server.baseUrl, assertion);
    const sessionB = await initializeRawSession(server.baseUrl, assertion);

    void rawMcp(
      server.baseUrl,
      toolCall(1, "bash", { command: "sleep 30 & echo $! > pidC.txt; wait" }),
      { assertion, sessionId: sessionA.sessionId },
    ).catch(() => undefined);
    void rawMcp(
      server.baseUrl,
      toolCall(1, "bash", { command: "sleep 30 & echo $! > pidD.txt; wait" }),
      { assertion, sessionId: sessionB.sessionId },
    ).catch(() => undefined);

    const pidC = await readPid("pidC.txt");
    const pidD = await readPid("pidD.txt");

    await rawMcp(server.baseUrl, undefined, { method: "DELETE", sessionId: sessionA.sessionId, assertion });
    expect(await waitForPidGone(pidC)).toBe(true);
    expect(isAlive(pidD)).toBe(true);

    await rawMcp(server.baseUrl, undefined, { method: "DELETE", sessionId: sessionB.sessionId, assertion });
    expect(await waitForPidGone(pidD)).toBe(true);
  });

  it("does not cancel work when the SSE stream is dropped", async () => {
    const assertion = await token();
    const session = await initializeRawSession(server.baseUrl, assertion);
    const marker = join(workspace.dir, "dropped-marker.txt");

    const controller = new AbortController();
    const call = fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-access-jwt-assertion": assertion,
        "mcp-session-id": session.sessionId,
      },
      body: JSON.stringify(
        toolCall(1, "bash", { command: "sleep 1; echo finished > dropped-marker.txt" }),
      ),
      signal: controller.signal,
    }).catch(() => undefined);

    await delay(200);
    controller.abort();
    await call;

    expect(await waitForFile(marker, 4000)).toBe(true);
    await rawMcp(server.baseUrl, undefined, { method: "DELETE", sessionId: session.sessionId, assertion });
  });
});
