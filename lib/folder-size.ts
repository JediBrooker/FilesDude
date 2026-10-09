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

type Limits = { entries: number; milliseconds: number };
const DEFAULT_LIMITS: Limits = { entries: 2_000_000, milliseconds: 60_000 };
const MAX_DEPTH = 256;
const STAT_BATCH = 32;
const ON_LINUX = process.platform === "linux";

type Folder = { base: string; real: string };

const emptySize = (): FolderSize => ({ bytes: 0, allocated: 0, files: 0, folders: 0, complete: true });

// Opens the starting folder under the filesystem lock, then lets `run` count from it.
async function fromFolder<T>(relativePath: string, run: (start: Folder, count: Counter) => Promise<T>, signal: AbortSignal | undefined, limits: Limits) {
  const release = await acquireFilesystemLock();
  let start: Awaited<ReturnType<typeof openDirectory>>;
  try {
    start = await openDirectory(relativePath);
  } finally {
    release();
  }
  try {
    return await run({ base: start.base, real: start.real }, new Counter(await reservedPathCheck(), limits, signal));
  } finally {
    await start.handle.close().catch(() => undefined);
  }
}

// Walks folders into FolderSize totals, sharing one budget of items and time across every walk.
class Counter {
  private entries = 0;
  private readonly startedAt = Date.now();
  private readonly linked = new Set<string>();
  ended: FolderSize["reason"] | null = null;

  constructor(private readonly isReserved: (real: string) => boolean, private readonly limits: Limits, private readonly signal?: AbortSignal) {}

  private stopShort(result: FolderSize, reason: NonNullable<FolderSize["reason"]>) {
    result.complete = false;
    if (reason !== "unreadable") this.ended = reason;
    if (result.reason !== "limit" && result.reason !== "time") result.reason = reason;
  }

  private checkCancelled() {
    if (this.signal?.aborted) throw new AppError("Counting was cancelled", 499, "CANCELLED");
  }

  private async countFile(location: string, result: FolderSize) {
    const stat = await fs.lstat(location).catch(() => null);
    if (!stat?.isFile()) return;
    if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      if (this.linked.has(key)) return;
      this.linked.add(key);
    }
    result.files += 1;
    result.bytes += stat.size;
    result.allocated += stat.blocks * 512;
  }

  /** Lists a folder: its files and its subfolders (other than FilesDude's own). */
  async list(folder: Folder, result: FolderSize) {
    const files: string[] = [];
    const folders: string[] = [];
    let directory;
    try {
      directory = await fs.opendir(folder.base);
    } catch {
      this.stopShort(result, "unreadable");
      return { files, folders };
    }
    try {
      for await (const entry of directory) {
        this.checkCancelled();
        this.entries += 1;
        if (this.entries > this.limits.entries) {
          this.stopShort(result, "limit");
          break;
        }
        if (Date.now() - this.startedAt > this.limits.milliseconds) {
          this.stopShort(result, "time");
          break;
        }
        if (INTERNAL_NAMES.has(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!this.isReserved(path.join(folder.real, entry.name))) folders.push(entry.name);
        } else if (entry.isFile()) {
          files.push(entry.name);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return { files, folders };
  }

  /** Runs `visit` on a subfolder opened inside its parent's handle, never through a link. */
  async within<T>(folder: Folder, name: string, result: FolderSize, visit: (child: Folder) => Promise<T>) {
    const real = path.join(folder.real, name);
    const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) {
      this.stopShort(result, "unreadable");
      return undefined;
    }
    try {
      return await visit({ base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, real });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Adds everything inside `folder` to `result`. */
  async walk(folder: Folder, result: FolderSize, depth = 0): Promise<void> {
    const { files, folders } = await this.list(folder, result);
    if (this.ended && this.ended !== "unreadable") return;
    for (let index = 0; index < files.length; index += STAT_BATCH) {
      await Promise.all(files.slice(index, index + STAT_BATCH).map((name) => this.countFile(path.join(folder.base, name), result)));
    }
    for (const name of folders) {
      this.checkCancelled();
      if (this.ended) return;
      if (depth >= MAX_DEPTH) return this.stopShort(result, "limit");
      result.folders += 1;
      await this.within(folder, name, result, (child) => this.walk(child, result, depth + 1));
    }
  }
}

export async function folderSize(relativePath: string, signal?: AbortSignal, limits = DEFAULT_LIMITS): Promise<FolderSize> {
  return fromFolder(relativePath, async (start, counter) => {
    const result = emptySize();
    await counter.walk(start, result);
    return result;
  }, signal, limits);
}

/**
 * The size of each folder directly inside a folder, for the Size column. All of them share one
 * budget; a folder not reached before it runs out is left out, and `complete` says so.
 */
export async function childFolderSizes(relativePath: string, signal?: AbortSignal, limits = DEFAULT_LIMITS) {
  return fromFolder(relativePath, async (start, counter) => {
    const top = emptySize();
    const { folders } = await counter.list(start, top);
    const sizes: Record<string, FolderSize> = {};
    for (const name of folders) {
      if (counter.ended) break;
      const result = emptySize();
      await counter.within(start, name, top, (child) => counter.walk(child, result));
      if (!counter.ended || result.complete) sizes[name] = result;
    }
    return { sizes, complete: !counter.ended && top.reason !== "unreadable" };
  }, signal, limits);
}
