import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeTool } from "../../src/tools/write.js";
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

describe("write tool", () => {
  it("creates parent directories recursively", async () => {
    const result = await writeTool({ path: "a/b/c/file.txt", content: "hi" }, env);
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(workspace.dir, "a/b/c/file.txt"), "utf-8")).toBe("hi");
  });

  it("overwrites an existing file", async () => {
    await writeFile(join(workspace.dir, "f.txt"), "old content that is longer");
    await writeTool({ path: "f.txt", content: "new" }, env);
    expect(await readFile(join(workspace.dir, "f.txt"), "utf-8")).toBe("new");
  });

  it("writes empty content", async () => {
    await writeTool({ path: "empty.txt", content: "" }, env);
    expect(await readFile(join(workspace.dir, "empty.txt"), "utf-8")).toBe("");
  });

  it("writes large content", async () => {
    const content = "x".repeat(200_000);
    await writeTool({ path: "big.txt", content }, env);
    expect(await readFile(join(workspace.dir, "big.txt"), "utf-8")).toBe(content);
  });

  it("leaves no temporary files behind", async () => {
    await writeTool({ path: "f.txt", content: "one" }, env);
    await writeTool({ path: "f.txt", content: "two" }, env);
    expect(await readdir(workspace.dir)).toEqual(["f.txt"]);
  });

  it("follows a symlink and preserves the link", async () => {
    await writeFile(join(workspace.dir, "target.txt"), "old");
    await symlink("target.txt", join(workspace.dir, "link.txt"));
    const result = await writeTool({ path: "link.txt", content: "new" }, env);
    expect(result.isError).toBeUndefined();
    expect((await lstat(join(workspace.dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(workspace.dir, "target.txt"), "utf-8")).toBe("new");
  });

  it("creates the target of a dangling symlink", async () => {
    await symlink("created.txt", join(workspace.dir, "dangling.txt"));
    const result = await writeTool({ path: "dangling.txt", content: "made" }, env);
    expect(result.isError).toBeUndefined();
    expect((await lstat(join(workspace.dir, "dangling.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(workspace.dir, "created.txt"), "utf-8")).toBe("made");
  });

  it("preserves the mode of an existing file", async () => {
    const file = join(workspace.dir, "mode.txt");
    await writeFile(file, "old");
    await chmod(file, 0o640);
    await writeTool({ path: "mode.txt", content: "new" }, env);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it("uses the process default mode for a new file", async () => {
    await writeTool({ path: "new.txt", content: "x" }, env);
    const mode = (await stat(join(workspace.dir, "new.txt"))).mode & 0o777;
    const expected = 0o666 & ~process.umask();
    expect(mode).toBe(expected);
  });

  it("returns a tool error when the target is a directory and leaves it untouched", async () => {
    await mkdir(join(workspace.dir, "adir"));
    const result = await writeTool({ path: "adir", content: "x" }, env);
    expect(result.isError).toBe(true);
    expect((await stat(join(workspace.dir, "adir"))).isDirectory()).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "returns a tool error on a permission failure and leaves no temp file",
    async () => {
      const dir = join(workspace.dir, "readonly");
      await mkdir(dir);
      await chmod(dir, 0o500);
      const result = await writeTool({ path: "readonly/file.txt", content: "x" }, env);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("EACCES");
      await chmod(dir, 0o700);
      expect(await readdir(dir)).toEqual([]);
    },
  );
});
