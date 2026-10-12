import { readFile, stat } from "node:fs/promises";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { detectImageMime } from "../lib/images.js";
import { resolveToolPath } from "../lib/paths.js";
import { selectLineWindow } from "../lib/text.js";
import { formatSize, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../lib/truncate.js";
import { errorResult, textResult } from "./result.js";
import type { ToolEnvironment } from "./types.js";

export const readInputSchema = z.object({
  path: z.string().describe("Path to the file to read (relative paths resolve against the workspace)."),
  offset: z.number().optional().describe("1-indexed line to start from (optional)."),
  limit: z.number().optional().describe("Maximum number of lines to read (optional)."),
});

export type ReadArgs = z.infer<typeof readInputSchema>;

function invalidArgument(name: string): CallToolResult {
  return textResult(`Invalid ${name}: must be a positive integer.`, true);
}

export async function readTool(args: ReadArgs, env: ToolEnvironment): Promise<CallToolResult> {
  const offset = args.offset;
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
    return invalidArgument("offset");
  }
  const limit = args.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return invalidArgument("limit");
  }

  const target = resolveToolPath(args.path, env.workspaceDir);
  const mimeType = detectImageMime(target);

  try {
    if (mimeType !== undefined) {
      const data = await readFile(target);
      return {
        content: [{ type: "image", data: data.toString("base64"), mimeType }],
      };
    }

    const stats = await stat(target);
    if (stats.isDirectory()) {
      return textResult(`Cannot read ${target}: it is a directory.`, true);
    }

    const content = await readFile(target, "utf-8");
    const window = selectLineWindow(content, offset ?? 1, limit);
    const truncated = truncateHead(window.content, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    if (truncated.firstLineExceedsLimit) {
      return textResult(
        `[First line of ${target} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; nothing shown.]`,
      );
    }

    let text = truncated.content;
    if (truncated.truncated) {
      const firstShown = window.startLine;
      const lastShown = window.startLine + truncated.outputLines - 1;
      const reason =
        truncated.truncatedBy === "lines"
          ? `${DEFAULT_MAX_LINES} line limit`
          : `${formatSize(DEFAULT_MAX_BYTES)} limit`;
      text += `\n\n[Showing lines ${firstShown}-${lastShown} of ${window.totalLines}; truncated by the ${reason}.]`;
    }
    return textResult(text);
  } catch (error) {
    return errorResult(error);
  }
}
