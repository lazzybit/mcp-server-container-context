import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { atomicWriteFile } from "../lib/fs/atomic.js";
import { resolveToolPath } from "../lib/paths.js";
import { errorResult, textResult } from "./result.js";
import type { ToolEnvironment } from "./types.js";

export const writeInputSchema = z.object({
  path: z.string().describe("Path to write (relative paths resolve against the workspace)."),
  content: z.string().describe("Content to write. May be empty."),
});

export type WriteArgs = z.infer<typeof writeInputSchema>;

export async function writeTool(args: WriteArgs, env: ToolEnvironment): Promise<CallToolResult> {
  const target = resolveToolPath(args.path, env.workspaceDir);
  try {
    await atomicWriteFile(target, args.content);
  } catch (error) {
    return errorResult(error);
  }
  const bytes = Buffer.byteLength(args.content, "utf-8");
  return textResult(`Wrote ${bytes} bytes to ${target}.`);
}
