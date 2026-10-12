import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { waitForChildProcess } from "../lib/process/child.js";
import { isGroupAlive, terminateGroup } from "../lib/process/group.js";
import { OutputAccumulator } from "../lib/process/output.js";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../lib/truncate.js";
import { errorResult, textResult } from "./result.js";
import { requestSignal, type ToolEnvironment } from "./types.js";

/** Grace between SIGTERM and SIGKILL when cleaning up a command's group. */
const TERMINATE_GRACE_MS = 1000;

export const bashInputSchema = z.object({
  command: z.string().describe("Shell command to execute."),
  timeout: z.number().optional().describe("Timeout in seconds (optional; no default timeout)."),
});

export const bashOutputSchema = z.object({
  output: z.string(),
  truncated: z.boolean(),
  full_output_path: z.string().optional(),
  exit_code: z.number(),
  wall_time_seconds: z.number(),
});

export type BashArgs = z.infer<typeof bashInputSchema>;

function mapExitCode(exitCode: number | null, signalCode: NodeJS.Signals | null): number {
  if (exitCode !== null) {
    return exitCode;
  }
  if (signalCode !== null) {
    const signalNumber = osConstants.signals[signalCode] ?? 0;
    return 128 + signalNumber;
  }
  return 1;
}

export async function bashTool(
  args: BashArgs,
  ctx: ServerContext,
  env: ToolEnvironment,
): Promise<CallToolResult> {
  const timeoutSeconds = args.timeout;
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    return textResult("Invalid timeout: must be a finite positive number of seconds.", true);
  }

  const signal = requestSignal(ctx, env);
  if (signal.aborted) {
    return textResult("Command aborted", true);
  }

  const accumulator = await OutputAccumulator.create();
  const startedAt = performance.now();

  let child;
  try {
    child = spawn("bash", ["-c", args.command], {
      cwd: env.workspaceDir,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    await accumulator.removeSpillFile();
    return errorResult(error);
  }

  const pgid = child.pid;
  if (pgid !== undefined) {
    env.registry.add(pgid);
  }

  let timedOut = false;
  let aborted = false;
  let termination: Promise<void> | undefined;
  const beginTermination = (): void => {
    if (termination === undefined && pgid !== undefined) {
      termination = terminateGroup(pgid, TERMINATE_GRACE_MS).catch(() => undefined);
    }
  };

  const onAbort = (): void => {
    aborted = true;
    beginTermination();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutSeconds !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, timeoutSeconds * 1000);
  }

  const onData = (chunk: Buffer): void => accumulator.append(chunk);
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let exitCode: number | null = null;
  let spawnError: unknown;
  try {
    exitCode = await waitForChildProcess(child);
  } catch (error) {
    spawnError = error;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    signal.removeEventListener("abort", onAbort);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  }

  // Always clean up the whole group; a same-group descendant may have outlived
  // the shell, and the group id stays addressable while any member exists.
  if (termination === undefined) {
    if (pgid !== undefined) {
      termination = terminateGroup(pgid, TERMINATE_GRACE_MS).catch(() => undefined);
    }
  }
  if (termination !== undefined) {
    await termination;
  }
  if (pgid !== undefined && !isGroupAlive(pgid)) {
    env.registry.remove(pgid);
  }

  await accumulator.close();

  if (spawnError !== undefined) {
    await accumulator.removeSpillFile();
    return errorResult(spawnError);
  }

  const snapshot = accumulator.snapshot();
  const truncated =
    snapshot.totalBytes > DEFAULT_MAX_BYTES || snapshot.totalLines > DEFAULT_MAX_LINES;
  const window = truncateTail(snapshot.tailText, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const outputText = truncated ? window.content : snapshot.tailText;
  const exitCodeValue = mapExitCode(exitCode, child.signalCode);

  let text = outputText;
  if (truncated) {
    const startLine = window.lastLinePartial
      ? snapshot.totalLines
      : Math.max(1, snapshot.totalLines - window.outputLines + 1);
    text += `\n\n[Showing lines ${startLine}-${snapshot.totalLines} of ${snapshot.totalLines}. Full output: ${accumulator.spillPath}]`;
  } else {
    await accumulator.removeSpillFile();
  }

  const status = aborted
    ? "Command aborted"
    : timedOut
      ? `Command timed out after ${timeoutSeconds} seconds`
      : exitCodeValue !== 0
        ? `Command exited with code ${exitCodeValue}`
        : undefined;

  const isError = status !== undefined;
  if (status !== undefined) {
    text = text.length > 0 ? `${text}\n\n${status}` : status;
  } else if (text.length === 0) {
    text = "(no output)";
  }

  const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;

  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
    structuredContent: {
      output: outputText,
      truncated,
      ...(truncated ? { full_output_path: accumulator.spillPath } : {}),
      exit_code: exitCodeValue,
      wall_time_seconds: wallTimeSeconds,
    },
  };
}
