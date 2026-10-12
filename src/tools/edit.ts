import { readFile } from "node:fs/promises";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { atomicWriteFile } from "../lib/fs/atomic.js";
import { resolveToolPath } from "../lib/paths.js";
import { errorResult, textResult } from "./result.js";
import type { ToolEnvironment } from "./types.js";

export const editInputSchema = z.object({
  path: z.string().describe("Path to edit (relative paths resolve against the workspace)."),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe("Exact text to replace. Must match exactly once."),
        newText: z.string().describe("Replacement text."),
      }),
    )
    .describe("Replacements, all matched against the original file content."),
});

export type EditArgs = z.infer<typeof editInputSchema>;
export type EditReplacement = EditArgs["edits"][number];

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

function preview(text: string): string {
  const single = text.replace(/\n/g, "\\n");
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

interface Span {
  start: number;
  end: number;
  newText: string;
}

/**
 * Validate and apply a batch of replacements against the original content.
 *
 * Every `oldText` is matched against the original, never against the
 * progressively edited result. All-or-nothing: any missing, ambiguous or
 * overlapping match throws before content is produced.
 */
export function applyEdits(original: string, edits: EditReplacement[]): string {
  if (edits.length === 0) {
    throw new EditError("At least one edit is required.");
  }

  const spans: Span[] = [];
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new EditError("Each edit must provide a non-empty oldText.");
    }
    let first = -1;
    let count = 0;
    let cursor = original.indexOf(edit.oldText);
    while (cursor !== -1) {
      count++;
      if (count === 1) {
        first = cursor;
      }
      // Advance by one so self-overlapping matches (e.g. "aa" in "aaa") are
      // reported as ambiguous instead of being missed.
      cursor = original.indexOf(edit.oldText, cursor + 1);
    }
    if (count === 0) {
      throw new EditError(`oldText not found: "${preview(edit.oldText)}"`);
    }
    if (count > 1) {
      throw new EditError(`oldText matches ${count} times (must match exactly once): "${preview(edit.oldText)}"`);
    }
    spans.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
  }

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (previous.end > current.start) {
      throw new EditError(
        `Edits overlap: "${preview(original.slice(previous.start, previous.end))}" and "${preview(
          original.slice(current.start, current.end),
        )}"`,
      );
    }
  }

  let result = "";
  let cursor = 0;
  for (const span of ordered) {
    result += original.slice(cursor, span.start);
    result += span.newText;
    cursor = span.end;
  }
  result += original.slice(cursor);
  return result;
}

export async function editTool(args: EditArgs, env: ToolEnvironment): Promise<CallToolResult> {
  const target = resolveToolPath(args.path, env.workspaceDir);
  try {
    const original = await readFile(target, "utf-8");
    const next = applyEdits(original, args.edits);
    await atomicWriteFile(target, next);
    return textResult(`Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} to ${target}.`);
  } catch (error) {
    if (error instanceof EditError) {
      return textResult(error.message, true);
    }
    return errorResult(error);
  }
}