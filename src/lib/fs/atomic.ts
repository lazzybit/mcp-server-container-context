import { randomBytes } from "node:crypto";
import { open, lstat, mkdir, readlink, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_SYMLINK_DEPTH = 40;

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Resolve the final path component through symlinks, matching what a shell
 * redirect does. A dangling symlink resolves to the (nonexistent) target so
 * the file is created there and the link is left in place. Intermediate
 * directories are not resolved here; the OS follows them on open/rename.
 */
export async function resolveFinalTarget(filePath: string): Promise<string> {
  let current = filePath;
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return current;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      return current;
    }
    const linkTarget = await readlink(current);
    current = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(current), linkTarget);
  }
  throw new Error(`Too many levels of symbolic links: ${filePath}`);
}

/**
 * Atomically replace `filePath` with `content`: write a temp file in the
 * destination directory, fsync it, then rename it over the target. A crash or
 * any failure before the rename leaves the destination untouched. An existing
 * regular file's mode is preserved; a newly created file gets the process
 * default (`0666 & ~umask`).
 */
export async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const target = await resolveFinalTarget(filePath);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });

  let existingMode: number | undefined;
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      const error = new Error(`EISDIR: illegal operation on a directory, open '${target}'`);
      (error as NodeJS.ErrnoException).code = "EISDIR";
      throw error;
    }
    existingMode = stats.mode & 0o7777;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", existingMode ?? 0o666);
    await handle.writeFile(content);
    if (existingMode !== undefined) {
      await handle.chmod(existingMode);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, target);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  // Best-effort durability for the rename itself; not required for correctness.
  try {
    const directoryHandle = await open(directory, "r");
    await directoryHandle.sync().catch(() => undefined);
    await directoryHandle.close();
  } catch {
    // Ignore: some filesystems refuse to open a directory for fsync.
  }
}
