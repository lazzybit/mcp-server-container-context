import { describe, expect, it } from "vitest";

import { truncateHead, truncateTail, DEFAULT_MAX_BYTES } from "../../src/lib/truncate.js";

const bigLine = (chars: number): string => "x".repeat(chars);

describe("truncateHead", () => {
  it("leaves content under both limits untouched", () => {
    const result = truncateHead("a\nb\nc");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("a\nb\nc");
    expect(result.totalLines).toBe(3);
  });

  it("keeps the first lines at the line limit", () => {
    const content = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
    const result = truncateHead(content, { maxLines: 2000, maxBytes: DEFAULT_MAX_BYTES });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(2000);
    expect(result.content.startsWith("line-0\n")).toBe(true);
    expect(result.content.endsWith("line-1999")).toBe(true);
  });

  it("stops at the byte limit without splitting a multi-byte character", () => {
    const content = "😀".repeat(20000); // 4 bytes each
    const result = truncateHead(content, { maxLines: 2000, maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.firstLineExceedsLimit).toBe(true);
    expect(result.content).toBe("");
  });

  it("keeps whole lines under a byte limit", () => {
    const content = "aa\nbb\ncc\ndd";
    const result = truncateHead(content, { maxBytes: 6 });
    expect(result.content).toBe("aa\nbb");
    expect(result.truncatedBy).toBe("bytes");
  });

  it("counts a trailing newline without adding a phantom line", () => {
    expect(truncateHead("a\nb\n").totalLines).toBe(2);
    expect(truncateHead("").totalLines).toBe(0);
  });
});

describe("truncateTail", () => {
  it("leaves content under both limits untouched", () => {
    const result = truncateTail("a\nb\nc");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("a\nb\nc");
  });

  it("keeps the last lines at the line limit", () => {
    const content = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
    const result = truncateTail(content, { maxLines: 2000, maxBytes: DEFAULT_MAX_BYTES });
    expect(result.truncated).toBe(true);
    expect(result.outputLines).toBe(2000);
    expect(result.content.startsWith("line-1000")).toBe(true);
    expect(result.content.endsWith("line-2999")).toBe(true);
  });

  it("cuts an over-long single line at a UTF-8 boundary from the end", () => {
    const content = "😀".repeat(100);
    const result = truncateTail(content, { maxLines: 2000, maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(10);
    expect(result.content.endsWith("😀")).toBe(true);
  });

  it("keeps a huge line's tail and reports the line count", () => {
    const content = `${bigLine(1000)}\n${bigLine(1000)}`;
    const result = truncateTail(content, { maxBytes: 100 });
    expect(result.truncatedBy).toBe("bytes");
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(100);
  });
});
