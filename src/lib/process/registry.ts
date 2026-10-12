import { terminateGroup } from "./group.js";

/**
 * Per-session registry of live process groups. Groups stay registered after
 * their leader exits or their call finishes, so session close and process
 * shutdown can still terminate survivors.
 */
export class ProcessGroupRegistry {
  private readonly groups = new Set<number>();

  add(pgid: number): void {
    this.groups.add(pgid);
  }

  remove(pgid: number): void {
    this.groups.delete(pgid);
  }

  get size(): number {
    return this.groups.size;
  }

  snapshot(): number[] {
    return [...this.groups];
  }

  /** Terminate every tracked group, then forget them. */
  async terminateAll(graceMs?: number): Promise<void> {
    const pgids = this.snapshot();
    this.groups.clear();
    await Promise.all(pgids.map((pgid) => terminateGroup(pgid, graceMs).catch(() => undefined)));
  }
}
