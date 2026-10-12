/**
 * Process-group helpers for the `bash` tool. Each command is spawned with
 * `detached: true`, so the shell's pid is also its process-group id.
 */

const DEFAULT_TERMINATE_GRACE_MS = 1000;
const DEFAULT_POLL_MS = 25;

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Send a signal to a process group, falling back to the leader pid alone. */
export function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
    return;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") {
      return;
    }
    if (code === "EPERM") {
      // The group exists but we cannot signal it; nothing more to do.
      return;
    }
  }
  try {
    process.kill(pgid, signal);
  } catch {
    // Process already gone.
  }
}

/** Whether the process group still has any member we can see. */
export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminate a process group with escalation: `SIGTERM`, a bounded grace during
 * which the group may clean up, then `SIGKILL`. Idempotent and safe to call
 * when the leader has already exited — the group id stays addressable while
 * any member exists.
 */
export async function terminateGroup(
  pgid: number,
  graceMs: number = DEFAULT_TERMINATE_GRACE_MS,
): Promise<void> {
  if (!isGroupAlive(pgid)) {
    return;
  }
  killGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(DEFAULT_POLL_MS);
    if (!isGroupAlive(pgid)) {
      return;
    }
  }
  killGroup(pgid, "SIGKILL");
  // Give the kernel a moment to tear the group down.
  const killDeadline = Date.now() + 500;
  while (Date.now() < killDeadline) {
    await delay(DEFAULT_POLL_MS);
    if (!isGroupAlive(pgid)) {
      return;
    }
  }
}
