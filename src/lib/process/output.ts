import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_TAIL_BYTES = 1024 * 1024;

export interface OutputSnapshot {
  /** The retained tail of the output, decoded as UTF-8. */
  tailText: string;
  totalBytes: number;
  totalLines: number;
}

/**
 * Streams command output to a spill file while retaining a bounded tail in
 * memory. The tail is large enough that tail truncation (2000 lines / 50 KiB)
 * always has a complete window to work from.
 */
export class OutputAccumulator {
  private readonly stream: WriteStream;
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;
  private newlineCount = 0;
  private lastByte: number | undefined;
  private closed = false;

  private constructor(
    readonly spillPath: string,
    private readonly tailLimit: number,
  ) {
    this.stream = createWriteStream(spillPath, { flags: "w" });
    this.stream.on("error", () => undefined);
  }

  static async create(prefix = "mcp-bash", tailLimit = DEFAULT_TAIL_BYTES): Promise<OutputAccumulator> {
    const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
    return new OutputAccumulator(join(directory, "output.log"), tailLimit);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.totalBytes += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        this.newlineCount++;
      }
    }
    this.lastByte = chunk[chunk.length - 1];
    if (!this.stream.destroyed) {
      this.stream.write(chunk);
    }
    this.tailChunks.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailLimit && this.tailChunks.length > 0) {
      const removed = this.tailChunks.shift();
      if (removed === undefined) {
        break;
      }
      this.tailBytes -= removed.length;
    }
  }

  get totalLines(): number {
    if (this.totalBytes === 0) {
      return 0;
    }
    return this.newlineCount + (this.lastByte === 0x0a ? 0 : 1);
  }

  snapshot(): OutputSnapshot {
    return {
      tailText: Buffer.concat(this.tailChunks, this.tailBytes).toString("utf-8"),
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
    };
  }

  /** Flush and close the spill file, keeping it on disk. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve) => {
      if (this.stream.writableFinished || this.stream.destroyed) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
      this.stream.once("error", () => resolve());
    });
  }

  /** Delete the spill file and its temporary directory. */
  async removeSpillFile(): Promise<void> {
    await rm(dirname(this.spillPath), { recursive: true, force: true });
  }
}
