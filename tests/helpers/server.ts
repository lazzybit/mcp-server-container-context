import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { AccessAssertionVerifier } from "../../src/auth/access.js";
import type { Config } from "../../src/config.js";
import { createHttpServer } from "../../src/http/server.js";
import { McpSessionRegistry } from "../../src/mcp/sessions.js";
import { silentLogger } from "./logger.js";

export interface TestServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly sessions: McpSessionRegistry;
  close(): Promise<void>;
}

export interface TestServerOptions {
  readonly verifier: AccessAssertionVerifier;
  readonly workspaceDir: string;
  readonly issuer?: string;
  readonly mcpDomain?: string;
  readonly sessionSweepMs?: number;
}

export async function startTestServer(options: TestServerOptions): Promise<TestServer> {
  const config: Config = {
    teamDomain: "team.example.com",
    issuer: options.issuer ?? "https://team.example.com",
    applicationAud: "test-aud-tag",
    mcpDomain: options.mcpDomain ?? "127.0.0.1",
    host: "127.0.0.1",
    port: 0,
    workspaceDir: options.workspaceDir,
    sessionSweepMs: options.sessionSweepMs ?? 0,
  };

  const shutdown = new AbortController();
  const sessions = new McpSessionRegistry({
    config,
    logger: silentLogger(),
    shutdownSignal: shutdown.signal,
  });
  const server: Server = createHttpServer({
    config,
    logger: silentLogger(),
    verifier: options.verifier,
    sessions,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    sessions,
    close: async () => {
      shutdown.abort();
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
