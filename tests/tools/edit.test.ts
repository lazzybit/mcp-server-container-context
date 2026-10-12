import { chmod, lstat, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdits, editTool, EditError } from "../../src/tools/edit.js";
import { createTestEnv, textOf } from "../helpers/env.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tmp.js";

let workspace: TempWorkspace;
let env: ReturnType<typeof createTestEnv>;

beforeEach(async () => {
  workspace = await createTempWorkspace();
  env = createTestEnv(workspace.dir);
});

afterEach(async () => {
  await workspace.cleanup();
});

async function seed(content: string, name = "f.txt"): Promise<string> {
  const file = join(workspace.dir, name);
  await writeFile(file, content);
  return file;
}

describe("edit tool", () => {
  it("applies multiple replacements matched against the original", async () => {
    await seed("alpha beta gamma");
    const result = await editTool(
      {
        path: "f.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      },
      env,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(workspace.dir, "f.txt"), "utf-8")).toBe("ALPHA beta GAMMA");
  });

  it("allows adjacent edits", async () => {
    await seed("abcd");
    await editTool(
      {
        path: "f.txt",
        edits: [
          { oldText: "ab", newText: "AB" },
          { oldText: "cd", newText: "CD" },
        ],
      },
      env,
    );
    expect(await readFile(join(workspace.dir, "f.txt"), "utf-8")).toBe("ABCD");
  });

  it.each([
    ["overlap", "abcd", [{ oldText: "abc", newText: "x" }, { oldText: "bcd", newText: "y" }]],
    ["duplicate match", "aaa", [{ oldText: "a", newText: "b" }]],
    ["missing match", "abc", [{ oldText: "zzz", newText: "b" }]],
    ["empty oldText", "abc", [{ oldText: "", newText: "b" }]],
  ])("rejects %s and leaves the file byte-identical", async (_label, content, edits) => {
    await seed(content);
    const before = await readFile(join(workspace.dir, "f.txt"));
    const result = await editTool({ path: "f.txt", edits }, env);
    expect(result.isError).toBe(true);
    const after = await readFile(join(workspace.dir, "f.txt"));
    expect(after.equals(before)).toBe(true);
  });

  it("rejects an empty edit list", async () => {
    await seed("abc");
    const result = await editTool({ path: "f.txt", edits: [] }, env);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/at least one edit/i);
  });

  it("returns a tool error for a missing file without creating it", async () => {
    const result = await editTool(
      { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
      env,
    );
    expect(result.isError).toBe(true);
  });

  it("follows a symlink, preserves the link and the target mode", async () => {
    const target = await seed("hello", "target.txt");
    await chmod(target, 0o640);
    await symlink("target.txt", join(workspace.dir, "link.txt"));

    const result = await editTool(
      { path: "link.txt", edits: [{ oldText: "hello", newText: "world" }] },
      env,
    );
    expect(result.isError).toBeUndefined();
    expect((await lstat(join(workspace.dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf-8")).toBe("world");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });
});

describe("applyEdits matching", () => {
  it("matches every edit against the original, not incrementally", () => {
    // "bar" only exists after the first replacement; the batch must be rejected.
    expect(() =>
      applyEdits("foo", [
        { oldText: "foo", newText: "bar" },
        { oldText: "bar", newText: "baz" },
      ]),
    ).toThrow(/not found/);
  });

  it("reports a self-overlapping match as ambiguous", () => {
    // "aa" occurs at index 0 and index 1 in "aaa".
    expect(() => applyEdits("aaa", [{ oldText: "aa", newText: "x" }])).toThrow(/matches 2 times/);
  });

  it("produces a distinct message for each failure class", () => {
    const messages = new Set<string>();
    const collect = (fn: () => unknown): void => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(EditError);
        messages.add((error as Error).message.replace(/"[^"]*"/g, '"X"'));
      }
    };
    collect(() => applyEdits("abc", []));
    collect(() => applyEdits("abc", [{ oldText: "", newText: "x" }]));
    collect(() => applyEdits("abc", [{ oldText: "zzz", newText: "x" }]));
    collect(() => applyEdits("aaa", [{ oldText: "a", newText: "b" }]));
    collect(() =>
      applyEdits("abcd", [
        { oldText: "abc", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ]),
    );
    expect(messages.size).toBe(5);
  });
});
