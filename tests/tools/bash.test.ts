import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bashTool, type BashArgs } from "../../src/tools/bash.js";
import { createTestEnv, fakeContext, textOf, type TestEnv } from "../helpers/env.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tmp.js";

let workspace: TempWorkspace;
let env: TestEnv;

beforeEach(async () => {
  workspace = await createTempWorkspace();
  env = createTestEnv(workspace.dir);
});

afterEach(async () => {
  await env.registry.terminateAll(200);
  await workspace.cleanup();
});

interface BashStructured {
  output: string;
  truncated: boolean;
  full_output_path?: string;
  exit_code: number;
  wall_time_seconds: number;
}

function structured(result: { structuredContent?: unknown }): BashStructured {
  return result.structuredContent as BashStructured;
}

async function run(args: BashArgs, toolEnv: TestEnv = env, signal?: AbortSignal) {
  return bashTool(args, fakeContext(signal), toolEnv);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

async function readPid(file: string): Promise<number> {
  const text = await readFile(join(workspace.dir, file), "utf-8");
  return Number.parseInt(text.trim(), 10);
}

describe("bash tool", () => {
  it("combines stdout and stderr", async () => {
    const result = await run({ command: "echo out; echo err 1>&2" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("out");
    expect(textOf(result)).toContain("err");
    expect(structured(result).exit_code).toBe(0);
  });

  it("reports a non-zero exit code as a tool error", async () => {
    const result = await run({ command: "echo before; exit 3" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before");
    expect(textOf(result)).toContain("Command exited with code 3");
    expect(structured(result).exit_code).toBe(3);
  });

  it("maps a signal-killed shell to 128 + signal number", async () => {
    const result = await run({ command: "kill -TERM $$" });
    expect(result.isError).toBe(true);
    expect(structured(result).exit_code).toBe(143);
    expect(textOf(result)).toContain("Command exited with code 143");
  });

  it("truncates large output, keeps the tail, and spills the full output", async () => {
    const result = await run({ command: "seq 1 5000" });
    const info = structured(result);
    expect(info.truncated).toBe(true);
    expect(info.full_output_path).toBeDefined();
    expect(textOf(result)).toContain("Full output:");
    const full = await readFile(info.full_output_path!, "utf-8");
    expect(full.trimEnd().split("\n").at(-1)).toBe("5000");
    expect(info.output.trimEnd().split("\n").at(-1)).toBe("5000");
  });

  it("preserves output received just after the shell exits", async () => {
    const result = await run({ command: "echo early; (sleep 0.05; echo late) &" });
    expect(textOf(result)).toContain("early");
    expect(textOf(result)).toContain("late");
  });

  it("runs in the workspace directory", async () => {
    const result = await run({ command: "pwd -P" });
    expect(textOf(result).trim()).toBe(await realpath(workspace.dir));
  });

  it("does not persist shell state between calls", async () => {
    await run({ command: "export CTX_TEST_VAR=leaked" });
    const result = await run({ command: 'echo "${CTX_TEST_VAR:-unset}"' });
    expect(textOf(result).trim()).toBe("unset");
  });

  it("persists filesystem changes", async () => {
    await run({ command: "echo hello > made.txt" });
    expect(await readFile(join(workspace.dir, "made.txt"), "utf-8")).toBe("hello\n");
  });

  it("times out and kills the whole process group", async () => {
    const started = Date.now();
    const result = await run({ command: "sleep 30 & echo $! > pid.txt; wait", timeout: 0.5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command timed out after 0.5 seconds");
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await waitForPidGone(await readPid("pid.txt"))).toBe(true);
  });

  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await run({ command: 'echo $$ > pid.txt; trap "" TERM; while :; do sleep 0.2; done', timeout: 0.5 });
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(8000);
    expect(await waitForPidGone(await readPid("pid.txt"))).toBe(true);
  });

  it("cleans up the group when the shell leader exited early", async () => {
    const result = await run({ command: "sleep 30 & echo $! > pid.txt" });
    expect(structured(result).exit_code).toBe(0);
    const pid = await readPid("pid.txt");
    expect(await waitForPidGone(pid)).toBe(true);
  });

  it("completes an explicit long command without a timeout", async () => {
    const result = await run({ command: "sleep 0.5; echo done" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result).trim()).toBe("done");
    expect(structured(result).wall_time_seconds).toBeGreaterThanOrEqual(0.4);
  });

  it("reports empty output", async () => {
    const result = await run({ command: "true" });
    expect(textOf(result)).toBe("(no output)");
    expect(structured(result).exit_code).toBe(0);
  });

  it("rejects an invalid timeout before spawning", async () => {
    const result = await run({ command: "sleep 30", timeout: 0 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid timeout");
  });

  it("cancels in-flight work via the request signal", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = run({ command: "sleep 30" }, env, controller.signal);
    setTimeout(() => controller.abort(), 150);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command aborted");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("cancels in-flight work via the session signal", async () => {
    const started = Date.now();
    const promise = run({ command: "sleep 30" });
    setTimeout(() => env.sessionAbort.abort(), 150);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command aborted");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
