import type { CallToolResult } from "@modelcontextprotocol/server";

export function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function errorResult(error: unknown): CallToolResult {
  return textResult(errorMessage(error), true);
}
