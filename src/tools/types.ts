import type { ServerContext } from "@modelcontextprotocol/server";

import type { Logger } from "../logging.js";
import type { ProcessGroupRegistry } from "../lib/process/registry.js";

/** Runs a tool handler while tracking it as active session work. */
export type WorkTracker = <T>(task: () => Promise<T>) => Promise<T>;

/** Dependencies handed to every tool handler. */
export interface ToolEnvironment {
  /** Base for relative paths and the `bash` working directory. */
  readonly workspaceDir: string;
  /** Live process groups owned by the session serving this request. */
  readonly registry: ProcessGroupRegistry;
  /** Aborted when the session closes (DELETE / transport close). */
  readonly sessionSignal: AbortSignal;
  /** Aborted on process shutdown (SIGTERM/SIGINT). */
  readonly shutdownSignal: AbortSignal;
  readonly logger: Logger;
  /**
   * Marks a tool handler as in-flight so the idle sweep never closes a session
   * that still has running work. Dropped HTTP/SSE connections do not end work.
   */
  readonly trackWork: WorkTracker;
}

/**
 * Compose the request signal with session and shutdown cancellation. A request
 * is cancelled when any of the three aborts.
 */
export function requestSignal(ctx: ServerContext, env: ToolEnvironment): AbortSignal {
  return AbortSignal.any([ctx.mcpReq.signal, env.sessionSignal, env.shutdownSignal]);
}
