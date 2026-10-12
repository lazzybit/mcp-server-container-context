/** Image path detection used by the `read` tool. */

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Return the MIME type for a supported image extension, or `undefined`. */
export function detectImageMime(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return IMAGE_MIME_BY_EXTENSION[lower.slice(dot)];
}
