import type { ServerContext } from "@modelcontextprotocol/server";

import { ProcessGroupRegistry } from "../../src/lib/process/registry.js";
import type { ToolEnvironment, WorkTracker } from "../../src/tools/types.js";
import { silentLogger } from "./logger.js";

export interface TestEnv extends ToolEnvironment {
  readonly registry: ProcessGroupRegistry;
  readonly sessionAbort: AbortController;
  readonly shutdownAbort: AbortController;
  readonly activeWork: { count: number };
}

export function createTestEnv(workspaceDir: string): TestEnv {
  const registry = new ProcessGroupRegistry();
  const sessionAbort = new AbortController();
  const shutdownAbort = new AbortController();
  const activeWork = { count: 0 };
  const trackWork: WorkTracker = (task) => {
    activeWork.count++;
    return task().finally(() => {
      activeWork.count--;
    });
  };
  return {
    workspaceDir,
    registry,
    sessionSignal: sessionAbort.signal,
    shutdownSignal: shutdownAbort.signal,
    logger: silentLogger(),
    trackWork,
    sessionAbort,
    shutdownAbort,
    activeWork,
  };
}

/** A minimal `ServerContext` carrying only the fields the tools read. */
export function fakeContext(signal?: AbortSignal): ServerContext {
  return {
    sessionId: "test-session",
    mcpReq: {
      id: 1,
      method: "tools/call",
      signal: signal ?? new AbortController().signal,
      requestState: () => undefined,
    },
  } as unknown as ServerContext;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export function textOf(result: { content: unknown[] }): string {
  const block = result.content[0] as TextBlock | undefined;
  return block?.text ?? "";
}
