import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { acquireFilesystemLock, INTERNAL_NAMES, openDirectory } from "./files";
import { AppError } from "./http";

/**
 * How much a folder holds: its files and subfolders, their total size, and the space they take on
 * disk (less than the size when ZFS compresses, more for many tiny files). A file hard-linked in
 * several places counts once. The walk opens each folder without following links, leaves out
 * FilesDude's own folders, and holds the filesystem lock only to open the starting folder.
 */
export type FolderSize = {
  bytes: number;
  allocated: number;
  files: number;
  folders: number;
  complete: boolean;
  /** Why counting stopped short: too many items, too long, or folders that couldn't be read. */
  reason?: "limit" | "time" | "unreadable";
};

const MAX_ENTRIES = 2_000_000;
const MAX_MILLISECONDS = 60_000;
const MAX_DEPTH = 256;
const STAT_BATCH = 32;
const ON_LINUX = process.platform === "linux";

type Folder = { base: string; real: string };

export async function folderSize(relativePath: string, signal?: AbortSignal, limits = { entries: MAX_ENTRIES, milliseconds: MAX_MILLISECONDS }): Promise<FolderSize> {
  const release = await acquireFilesystemLock();
  let start: Awaited<ReturnType<typeof openDirectory>>;
  try {
    start = await openDirectory(relativePath);
  } finally {
    release();
  }
  const isReserved = await reservedPathCheck();
  const startedAt = Date.now();
  const linked = new Set<string>();
  const result: FolderSize = { bytes: 0, allocated: 0, files: 0, folders: 0, complete: true };
  let entries = 0;
  // Unreadable folders are noted and skipped; the limits end the count.
  const stopShort = (reason: NonNullable<FolderSize["reason"]>) => {
    result.complete = false;
    if (result.reason !== "limit" && result.reason !== "time") result.reason = reason;
  };
  const ended = () => result.reason === "limit" || result.reason === "time";

  async function countFile(location: string) {
    const stat = await fs.lstat(location).catch(() => null);
    if (!stat?.isFile()) return;
    if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      if (linked.has(key)) return;
      linked.add(key);
    }
    result.files += 1;
    result.bytes += stat.size;
    result.allocated += stat.blocks * 512;
  }

  async function walk(folder: Folder, depth: number): Promise<void> {
    const files: string[] = [];
    const folders: string[] = [];
    let directory;
    try {
      directory = await fs.opendir(folder.base);
    } catch {
      stopShort("unreadable");
      return;
    }
    try {
      for await (const entry of directory) {
        if (signal?.aborted) throw new AppError("Counting was cancelled", 499, "CANCELLED");
        entries += 1;
        if (entries > limits.entries) return stopShort("limit");
        if (Date.now() - startedAt > limits.milliseconds) return stopShort("time");
        if (INTERNAL_NAMES.has(entry.name)) continue;
        if (entry.isDirectory()) folders.push(entry.name);
        else if (entry.isFile()) files.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (let index = 0; index < files.length; index += STAT_BATCH) {
      await Promise.all(files.slice(index, index + STAT_BATCH).map((name) => countFile(path.join(folder.base, name))));
    }
    for (const name of folders) {
      if (signal?.aborted) throw new AppError("Counting was cancelled", 499, "CANCELLED");
      if (ended()) return;
      const real = path.join(folder.real, name);
      if (isReserved(real)) continue;
      if (depth >= MAX_DEPTH) {
        stopShort("limit");
        return;
      }
      // Each subfolder is opened inside its parent's open handle, never through a link.
      const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (!handle) {
        stopShort("unreadable");
        continue;
      }
      try {
        result.folders += 1;
        await walk({ base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, real }, depth + 1);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }

  try {
    await walk({ base: start.base, real: start.real }, 0);
  } finally {
    await start.handle.close().catch(() => undefined);
  }
  return result;
}
