/**
 * Line/byte truncation utilities shared by the file and shell tools.
 *
 * Truncation is governed by two independent limits; whichever is hit first
 * wins:
 * - line limit (default 2000)
 * - byte limit (default 50 KiB)
 *
 * Whole lines are always kept, so a multi-byte character is never split. The
 * single exception is tail truncation of a lone line longer than the byte
 * limit, which cuts at a UTF-8 boundary.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export type TruncatedBy = "lines" | "bytes" | null;

export interface TruncationResult {
  /** The kept content. */
  content: string;
  truncated: boolean;
  truncatedBy: TruncatedBy;
  /** Total lines in the input. */
  totalLines: number;
  /** Total bytes in the input. */
  totalBytes: number;
  /** Lines in `content`. */
  outputLines: number;
  /** Bytes in `content`. */
  outputBytes: number;
  /** True when the first kept line is a partial tail of an over-long line. */
  lastLinePartial: boolean;
  /** True when the head's first line alone exceeds the byte limit. */
  firstLineExceedsLimit: boolean;
  /** 1-indexed line number of the first kept line (0 when nothing is kept). */
  startLine: number;
  /** 1-indexed line number of the last kept line (0 when nothing is kept). */
  endLine: number;
  maxLines: number;
  maxBytes: number;
}

interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Cut a string to fit within a byte budget, measured from the end, at a UTF-8 boundary. */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) {
    return str;
  }
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString("utf-8");
}

/** Keep the head: the first complete lines that fit inside both limits. */
export function truncateHead(content: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      startLine: totalLines === 0 ? 0 : 1,
      endLine: totalLines,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      startLine: 0,
      endLine: 0,
      maxLines,
      maxBytes,
    };
  }

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: TruncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = kept.join("\n");
  const outputBytes = Buffer.byteLength(outputContent, "utf-8");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    startLine: kept.length === 0 ? 0 : 1,
    endLine: kept.length,
    maxLines,
    maxBytes,
  };
}

/** Keep the tail: the last complete lines that fit inside both limits. */
export function truncateTail(content: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      startLine: totalLines === 0 ? 0 : 1,
      endLine: totalLines,
      maxLines,
      maxBytes,
    };
  }

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: TruncatedBy = "lines";
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        kept.unshift(partial);
        keptBytes = Buffer.byteLength(partial, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = kept.join("\n");
  const outputBytes = Buffer.byteLength(outputContent, "utf-8");
  const startLine = lastLinePartial ? totalLines : totalLines - kept.length + 1;
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    startLine,
    endLine: totalLines,
    maxLines,
    maxBytes,
  };
}
