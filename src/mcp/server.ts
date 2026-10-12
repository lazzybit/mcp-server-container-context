import { McpServer } from "@modelcontextprotocol/server";

import { bashInputSchema, bashOutputSchema, bashTool } from "../tools/bash.js";
import { editInputSchema, editTool } from "../tools/edit.js";
import { readInputSchema, readTool } from "../tools/read.js";
import { writeInputSchema, writeTool } from "../tools/write.js";
import type { ToolEnvironment } from "../tools/types.js";

export const SERVER_NAME = "container-context";
export const SERVER_VERSION = "1.0.0";

/**
 * Build a fresh MCP server with exactly the four container-context tools. Each
 * session gets its own instance so cancellation and session state never leak
 * across clients.
 */
export function createMcpServer(env: ToolEnvironment): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "read",
    {
      title: "Read",
      description:
        "Read a text file or image. Text is truncated to 2000 lines or 50KB, whichever comes first.",
      inputSchema: readInputSchema,
    },
    (args) => env.trackWork(() => readTool(args, env)),
  );

  server.registerTool(
    "write",
    {
      title: "Write",
      description: "Write a file, creating parent directories. Overwrites existing files atomically.",
      inputSchema: writeInputSchema,
    },
    (args) => env.trackWork(() => writeTool(args, env)),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit",
      description:
        "Apply exact, non-overlapping replacements to a file. All edits match the original content.",
      inputSchema: editInputSchema,
    },
    (args) => env.trackWork(() => editTool(args, env)),
  );

  server.registerTool(
    "bash",
    {
      title: "Bash",
      description:
        "Execute a bash command in the workspace. Returns combined stdout and stderr, truncated to the last 2000 lines or 50KB.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
    },
    (args, ctx) => env.trackWork(() => bashTool(args, ctx, env)),
  );

  return server;
}
