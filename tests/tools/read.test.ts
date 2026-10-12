import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTool } from "../../src/tools/read.js";
import { createTestEnv, textOf, type ImageBlock } from "../helpers/env.js";
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

describe("read tool", () => {
  it("reads a text file", async () => {
    await writeFile(join(workspace.dir, "notes.txt"), "line1\nline2\nline3\n");
    const result = await readTool({ path: "notes.txt" }, env);
    expect(textOf(result)).toBe("line1\nline2\nline3");
    expect(result.isError).toBeUndefined();
  });

  it("reads an empty file", async () => {
    await writeFile(join(workspace.dir, "empty.txt"), "");
    const result = await readTool({ path: "empty.txt" }, env);
    expect(textOf(result)).toBe("");
  });

  it("honours a 1-indexed offset and limit", async () => {
    await writeFile(join(workspace.dir, "n.txt"), "a\nb\nc\nd\ne");
    expect(textOf(await readTool({ path: "n.txt", offset: 2, limit: 2 }, env))).toBe("b\nc");
    expect(textOf(await readTool({ path: "n.txt", offset: 4 }, env))).toBe("d\ne");
    expect(textOf(await readTool({ path: "n.txt", offset: 10 }, env))).toBe("");
  });

  it.each([
    ["offset", { path: "n.txt", offset: 0 }],
    ["offset", { path: "n.txt", offset: 1.5 }],
    ["limit", { path: "n.txt", limit: 0 }],
    ["limit", { path: "n.txt", limit: -3 }],
  ])("rejects a non-positive/integer %s as a tool error", async (name, args) => {
    await writeFile(join(workspace.dir, "n.txt"), "a\nb");
    const result = await readTool(args, env);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Invalid ${name}`);
  });

  it("truncates at the 2000-line boundary and reports the notice", async () => {
    const content = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n");
    await writeFile(join(workspace.dir, "long.txt"), content);
    const result = await readTool({ path: "long.txt" }, env);
    const text = textOf(result);
    expect(text).toContain("[Showing lines 1-2000 of 2500");
    expect(text).toContain("2000 line limit");
    expect(text).toContain("line-1999");
    expect(text).not.toContain("line-2000");
  });

  it("truncates at the 50KB byte boundary without splitting a multi-byte character", async () => {
    const line = `${"😀".repeat(50)}`;
    const content = Array.from({ length: 1000 }, () => line).join("\n");
    await writeFile(join(workspace.dir, "emoji.txt"), content);
    const result = await readTool({ path: "emoji.txt" }, env);
    const text = textOf(result);
    expect(text).toContain("limit");
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(text).not.toContain("\uFFFD");
  });

  it("returns image content for each supported extension", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const extensions: ReadonlyArray<[string, string]> = [
      ["png", "image/png"],
      ["PNG", "image/png"],
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["bmp", "image/bmp"],
    ];
    for (const [extension, mime] of extensions) {
      const file = `image.${extension}`;
      await writeFile(join(workspace.dir, file), bytes);
      const result = await readTool({ path: file }, env);
      const block = result.content[0] as ImageBlock;
      expect(block.type).toBe("image");
      expect(block.mimeType).toBe(mime);
      expect(Buffer.from(block.data, "base64")).toEqual(bytes);
    }
  });

  it("returns a tool error for a missing file", async () => {
    const result = await readTool({ path: "missing.txt" }, env);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ENOENT");
  });

  it("returns a tool error for a directory", async () => {
    await mkdir(join(workspace.dir, "subdir"));
    const result = await readTool({ path: "subdir" }, env);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("directory");
  });

  it.skipIf(process.getuid?.() === 0)("returns a tool error on a permission failure", async () => {
    const file = join(workspace.dir, "secret.txt");
    await writeFile(file, "secret");
    await chmod(file, 0o000);
    const result = await readTool({ path: "secret.txt" }, env);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("EACCES");
  });
});
