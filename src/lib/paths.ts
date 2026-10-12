import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a tool path against the workspace. Absolute paths act on the
 * container filesystem as given; relative paths resolve against
 * `WORKSPACE_DIR`. There is no sandbox, consistent with running arbitrary
 * `bash`.
 */
export function resolveToolPath(inputPath: string, workspaceDir: string): string {
  if (isAbsolute(inputPath)) {
    return inputPath;
  }
  return resolve(workspaceDir, inputPath);
}
