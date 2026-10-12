import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest, type McpServer } from "@modelcontextprotocol/server";

import type { AccessIdentity } from "../auth/access.js";
import type { Config } from "../config.js";
import type { Logger } from "../logging.js";
import { ProcessGroupRegistry } from "../lib/process/registry.js";
import { headerValue, sendJson, sendUnauthorized } from "../http/respond.js";
import { createMcpServer } from "./server.js";

/** Keep the SDK's request-body bound in place. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
/** SSE keep-alive comment frames, to reduce the chance of an idle proxy cutting the stream. */
const KEEP_ALIVE_MS = 15_000;

interface SessionRecord {
  id: string;
  readonly identity: AccessIdentity;
  readonly transport: NodeStreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly registry: ProcessGroupRegistry;
  readonly abort: AbortController;
  /** Number of tool handlers currently running for this session. */
  activeWork: number;
  lastActivity: number;
  disposed: boolean;
}

export interface McpSessionRegistryOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly shutdownSignal: AbortSignal;
}

type BodyReadResult = { ok: true; body: unknown } | { ok: false };

/**
 * Owns the MCP Streamable HTTP sessions. Each session has its own `McpServer`,
 * transport, verified identity, cancellation controller and process-group
 * registry.
 */
export class McpSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly shutdownSignal: AbortSignal;
  private sweepTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(options: McpSessionRegistryOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.shutdownSignal = options.shutdownSignal;
    if (this.config.sessionSweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.config.sessionSweepMs);
      this.sweepTimer.unref();
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    identity: AccessIdentity,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const sessionId = headerValue(req, "mcp-session-id");

    if (method === "POST") {
      if (sessionId !== undefined) {
        await this.handleSessionRequest(req, res, sessionId, identity);
        return;
      }
      const read = await this.readBody(req, res);
      if (!read.ok) {
        return;
      }
      if (!isInitializeRequest(read.body)) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Missing Mcp-Session-Id header" },
          id: null,
        });
        return;
      }
      await this.createSession(req, res, identity, read.body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      if (sessionId === undefined) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      await this.handleSessionRequest(req, res, sessionId, identity);
      return;
    }

    sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
  }

  private async handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    identity: AccessIdentity,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    if (session.identity.id !== identity.id) {
      sendUnauthorized(res);
      return;
    }

    session.lastActivity = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } finally {
      session.lastActivity = Date.now();
    }
  }

  private async createSession(
    req: IncomingMessage,
    res: ServerResponse,
    identity: AccessIdentity,
    body: unknown,
  ): Promise<void> {
    const registry = new ProcessGroupRegistry();
    const abort = new AbortController();
    let record: SessionRecord;

    const trackWork = <T>(task: () => Promise<T>): Promise<T> => {
      record.activeWork++;
      record.lastActivity = Date.now();
      return task().finally(() => {
        record.activeWork--;
        record.lastActivity = Date.now();
      });
    };

    const server = createMcpServer({
      workspaceDir: this.config.workspaceDir,
      registry,
      sessionSignal: abort.signal,
      shutdownSignal: this.shutdownSignal,
      logger: this.logger,
      trackWork,
    });

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      keepAliveMs: KEEP_ALIVE_MS,
      onsessioninitialized: (sessionId) => {
        record.id = sessionId;
        this.sessions.set(sessionId, record);
        this.logger.info("session opened", { sessionId, subject: identity.subject });
      },
      onsessionclosed: (sessionId) => {
        void this.closeSession(sessionId, "client-delete");
      },
    });
    record = {
      id: "",
      identity,
      transport,
      server,
      registry,
      abort,
      activeWork: 0,
      lastActivity: Date.now(),
      disposed: false,
    };
    transport.onerror = (error) => {
      this.logger.warn("transport error", { message: error.message });
    };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        void this.closeSession(sessionId, "transport-close");
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<BodyReadResult> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.length;
        if (total > MAX_REQUEST_BODY_BYTES) {
          sendJson(res, 413, { error: "request body too large" });
          return { ok: false };
        }
        chunks.push(buffer);
      }
    } catch {
      sendJson(res, 400, { error: "failed to read request body" });
      return { ok: false };
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    if (text.trim().length === 0) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Empty request body" },
        id: null,
      });
      return { ok: false };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return { ok: false };
    }
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.disposed) {
      return;
    }
    session.disposed = true;
    this.sessions.delete(sessionId);
    this.logger.info("session closed", { sessionId, reason });

    session.abort.abort();
    await Promise.allSettled([
      session.server.close(),
      session.transport.close(),
      session.registry.terminateAll(),
    ]);
  }

  private sweep(): void {
    if (this.shuttingDown) {
      return;
    }
    const cutoff = Date.now() - this.config.sessionSweepMs;
    for (const session of [...this.sessions.values()]) {
      // Never cancel running work: sweep only sessions with no active tool
      // handler, regardless of whether an HTTP/SSE connection is still open.
      if (session.activeWork === 0 && session.lastActivity < cutoff) {
        void this.closeSession(session.id, "idle-sweep");
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId, "shutdown")),
    );
  }
}
