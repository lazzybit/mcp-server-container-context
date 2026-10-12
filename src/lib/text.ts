/** Line helpers shared by the read tool. */

export interface LineWindow {
  content: string;
  /** 1-indexed index of the first line in the full file. */
  startLine: number;
  /** 1-indexed index of the last line in the window, or `startLine - 1` when empty. */
  endLine: number;
  /** Total lines in the full content. */
  totalLines: number;
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

/**
 * Select a 1-indexed line window from the decoded content. `offset` defaults
 * to the first line and `limit` to the end of the file.
 */
export function selectLineWindow(content: string, offset: number, limit: number | undefined): LineWindow {
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  const startIndex = Math.min(offset - 1, totalLines);
  const endIndex = limit === undefined ? totalLines : Math.min(startIndex + limit, totalLines);
  const selected = lines.slice(startIndex, endIndex);
  return {
    content: selected.join("\n"),
    startLine: selected.length === 0 ? startIndex + 1 : startIndex + 1,
    endLine: selected.length === 0 ? startIndex : endIndex,
    totalLines,
  };
}
