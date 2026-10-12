import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspace {
  readonly dir: string;
  cleanup(): Promise<void>;
}

/** Create an isolated temporary directory to act as a workspace. */
export async function createTempWorkspace(prefix = "mcp-ctx-test-"): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
