import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { audit } from "./audit";
import { config } from "./config";
import { acquireFilesystemLock, copyOrMove, deleteEntries, INTERNAL_NAMES, normalizeRelative, openDirectory, safeResolve } from "./files";
import { AppError } from "./http";
import { startJob } from "./jobs";
import { rewriteLinkedPaths } from "./transfers";
import type { TransferResult } from "./types";

// Compares two folders (the two sides of the split view) and copies differences from one to the
// other. The walk opens each folder inside its parent's handle without following links, leaves out
// FilesDude's own folders, and holds the filesystem lock only to open the two starting folders. It
// only goes into folders both sides have: a folder on one side only is one difference, copied whole.

export type CompareItemType = "file" | "directory" | "symlink";

/** One side of a difference: what is there, as it was when compared. */
export type CompareSide = { type: CompareItemType; size: number; mtimeMs: number; modified: string };

export type CompareStatus = "onlyLeft" | "onlyRight" | "changed" | "typeMismatch";

export type CompareDifference = {
  /** Where the item is inside both compared folders. */
  path: string;
  status: CompareStatus;
  left?: CompareSide;
  right?: CompareSide;
  /** For changed files: which side was modified more recently (absent when the times match). */
  newer?: "left" | "right";
  /** For changed files compared byte by byte: their contents differ although their sizes match. */
  contentsDiffer?: boolean;
};

export type FolderComparison = {
  left: string;
  right: string;
  contents: boolean;
  differences: CompareDifference[];
  counts: Record<CompareStatus, number> & { identical: number; skipped: number };
  /** More differences were found than are listed. */
  truncated: boolean;
  complete: boolean;
  /** Why the comparison stopped short: too many items, too long, or folders that couldn't be read. */
  reason?: "limit" | "time" | "unreadable";
  elapsedMs: number;
};

type Limits = { entries: number; milliseconds: number; differences: number };
const DEFAULT_LIMITS: Limits = { entries: 1_000_000, milliseconds: 60_000, differences: 10_000 };
const MAX_DEPTH = 256;
const STAT_BATCH = 32;
const CHUNK = 1024 * 1024;
// File systems keep times at different precisions (FAT to two seconds), so times this close match.
const SAME_TIME_MS = 2_000;
const ON_LINUX = process.platform === "linux";

type Folder = { base: string; real: string };
type Item = CompareSide & { target?: string };

class Stop extends Error {}

const sideOf = ({ type, size, mtimeMs, modified }: Item): CompareSide => ({ type, size, mtimeMs, modified });

class Comparer {
  private entries = 0;
  readonly startedAt = Date.now();
  readonly result: FolderComparison;

  constructor(left: string, right: string, contents: boolean, private readonly isReserved: (real: string) => boolean, private readonly limits: Limits, private readonly signal?: AbortSignal) {
    this.result = {
      left, right, contents, differences: [], truncated: false, complete: true, elapsedMs: 0,
      counts: { onlyLeft: 0, onlyRight: 0, changed: 0, typeMismatch: 0, identical: 0, skipped: 0 },
    };
  }

  private stopShort(reason: NonNullable<FolderComparison["reason"]>): never {
    this.result.complete = false;
    this.result.reason = reason;
    throw new Stop();
  }

  private check() {
    if (this.signal?.aborted) throw new AppError("The comparison was cancelled", 499, "CANCELLED");
    if (Date.now() - this.startedAt > this.limits.milliseconds) this.stopShort("time");
  }

  private add(difference: CompareDifference) {
    this.result.counts[difference.status] += 1;
    if (this.result.differences.length < this.limits.differences) this.result.differences.push(difference);
    else this.result.truncated = true;
  }

  /** A folder's items by name: files, folders, and links (other items are counted as skipped). */
  private async list(folder: Folder) {
    const items = new Map<string, Item>();
    let directory;
    try {
      directory = await fs.opendir(folder.base);
    } catch {
      this.result.complete = false;
      this.result.reason ??= "unreadable";
      return null;
    }
    const names: string[] = [];
    try {
      for await (const entry of directory) {
        this.check();
        this.entries += 1;
        if (this.entries > this.limits.entries) this.stopShort("limit");
        if (INTERNAL_NAMES.has(entry.name)) continue;
        if (entry.isDirectory() && this.isReserved(path.join(folder.real, entry.name))) continue;
        names.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (let index = 0; index < names.length; index += STAT_BATCH) {
      await Promise.all(names.slice(index, index + STAT_BATCH).map(async (name) => {
        const location = path.join(folder.base, name);
        const stat = await fs.lstat(location).catch(() => null);
        const type: CompareItemType | null = stat?.isFile() ? "file" : stat?.isDirectory() ? "directory" : stat?.isSymbolicLink() ? "symlink" : null;
        if (!stat || !type) {
          this.result.counts.skipped += 1;
          return;
        }
        const target = type === "symlink" ? await fs.readlink(location).catch(() => "") : undefined;
        items.set(name, { type, size: type === "directory" ? 0 : stat.size, mtimeMs: stat.mtimeMs, modified: stat.mtime.toISOString(), target });
      }));
    }
    return items;
  }

  /** Runs `visit` on a subfolder opened inside its parent's handle, never through a link. */
  private async within<T>(folder: Folder, name: string, visit: (child: Folder) => Promise<T>) {
    const real = path.join(folder.real, name);
    const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) {
      this.result.complete = false;
      this.result.reason ??= "unreadable";
      return undefined;
    }
    try {
      return await visit({ base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, real });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Whether two files of the same size hold different bytes (null if either can't be read). */
  private async contentsDiffer(left: string, right: string) {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
    const [a, b] = await Promise.all([fs.open(left, flags).catch(() => null), fs.open(right, flags).catch(() => null)]);
    try {
      if (!a || !b || !(await a.stat()).isFile() || !(await b.stat()).isFile()) return null;
      const first = Buffer.allocUnsafe(CHUNK);
      const second = Buffer.allocUnsafe(CHUNK);
      for (let position = 0; ; position += CHUNK) {
        this.check();
        const [x, y] = await Promise.all([a.read(first, 0, CHUNK, position), b.read(second, 0, CHUNK, position)]);
        if (x.bytesRead !== y.bytesRead) return true;
        if (x.bytesRead === 0) return false;
        if (!first.subarray(0, x.bytesRead).equals(second.subarray(0, y.bytesRead))) return true;
      }
    } finally {
      await a?.close().catch(() => undefined);
      await b?.close().catch(() => undefined);
    }
  }

  async compare(left: Folder, right: Folder, relative: string, depth: number): Promise<void> {
    this.check();
    const [leftItems, rightItems] = await Promise.all([this.list(left), this.list(right)]);
    if (!leftItems || !rightItems) return;
    const names = [...new Set([...leftItems.keys(), ...rightItems.keys()])].sort();
    const folders: string[] = [];
    for (const name of names) {
      this.check();
      const itemPath = relative ? `${relative}/${name}` : name;
      const l = leftItems.get(name);
      const r = rightItems.get(name);
      if (l && !r) this.add({ path: itemPath, status: "onlyLeft", left: sideOf(l) });
      else if (r && !l) this.add({ path: itemPath, status: "onlyRight", right: sideOf(r) });
      else if (l && r && l.type !== r.type) this.add({ path: itemPath, status: "typeMismatch", left: sideOf(l), right: sideOf(r) });
      else if (l && r && l.type === "directory") folders.push(name);
      else if (l && r) {
        const apart = l.mtimeMs - r.mtimeMs;
        const newer = Math.abs(apart) <= SAME_TIME_MS ? undefined : apart > 0 ? "left" as const : "right" as const;
        let changed: boolean;
        let contentsDiffer: boolean | undefined;
        if (l.type === "symlink") changed = l.target !== r.target;
        else if (l.size !== r.size) changed = true;
        else if (this.result.contents) {
          const differ = await this.contentsDiffer(path.join(left.base, name), path.join(right.base, name));
          if (differ === null) {
            this.result.counts.skipped += 1;
            continue;
          }
          changed = differ;
          contentsDiffer = differ || undefined;
        } else changed = newer !== undefined;
        if (changed) this.add({ path: itemPath, status: "changed", left: sideOf(l), right: sideOf(r), newer, contentsDiffer });
        else this.result.counts.identical += 1;
      }
    }
    for (const name of folders) {
      if (depth >= MAX_DEPTH) this.stopShort("limit");
      const itemPath = relative ? `${relative}/${name}` : name;
      await this.within(left, name, (leftChild) => this.within(right, name, (rightChild) => this.compare(leftChild, rightChild, itemPath, depth + 1)));
    }
  }
}

const nested = (a: string, b: string) => a === b || a === "" || b === "" || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);

/** Refuses comparing a folder with itself, or with a folder inside it. */
function checkPair(left: string, right: string) {
  if (nested(left, right)) throw new AppError("Choose two separate folders, neither inside the other", 400, "NESTED_FOLDERS");
}

/**
 * Opens both folders (inside the account's folder, under the filesystem lock), refusing a pair that
 * is the same folder or one inside the other, by path or, through links, in reality.
 */
async function openPair(leftPath: string, rightPath: string) {
  const left = normalizeRelative(leftPath);
  const right = normalizeRelative(rightPath);
  checkPair(left, right);
  const release = await acquireFilesystemLock();
  let leftFolder: Awaited<ReturnType<typeof openDirectory>> | undefined;
  let rightFolder: Awaited<ReturnType<typeof openDirectory>> | undefined;
  try {
    leftFolder = await openDirectory(left);
    rightFolder = await openDirectory(right);
  } catch (error) {
    await leftFolder?.handle.close().catch(() => undefined);
    throw error;
  } finally {
    release();
  }
  const close = async () => {
    await leftFolder.handle.close().catch(() => undefined);
    await rightFolder.handle.close().catch(() => undefined);
  };
  const [realLeft, realRight] = [leftFolder.real, rightFolder.real];
  if (realLeft === realRight || realLeft.startsWith(`${realRight}${path.sep}`) || realRight.startsWith(`${realLeft}${path.sep}`)) {
    await close();
    checkPair("", "");
  }
  return { left, right, leftFolder, rightFolder, close };
}

/**
 * Compares two folders: what only one side has, and what differs. Files differ when their sizes do
 * or, unless `contents`, their modified times do; with `contents`, files of the same size are
 * compared byte by byte instead (times then don't matter).
 */
export async function compareFolders(leftPath: string, rightPath: string, { contents = false, signal, limits = DEFAULT_LIMITS }: { contents?: boolean; signal?: AbortSignal; limits?: Limits } = {}) {
  const { left, right, leftFolder, rightFolder, close } = await openPair(leftPath, rightPath);
  const realLeft = leftFolder.real;
  const realRight = rightFolder.real;
  try {
    const comparer = new Comparer(left, right, contents, await reservedPathCheck(), limits, signal);
    try {
      await comparer.compare({ base: leftFolder.base, real: realLeft }, { base: rightFolder.base, real: realRight }, "", 0);
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
    }
    comparer.result.elapsedMs = Date.now() - comparer.startedAt;
    return comparer.result;
  } finally {
    await close();
  }
}

/** One item to copy across: where it is inside both folders, which way, and both sides as compared. */
export type SyncItem = { path: string; to: "left" | "right"; left: CompareSide | null; right: CompareSide | null };
export type SyncSkip = { path: string; reason: "changed" | "failed"; message?: string };

// What is at this path now, to check nothing changed since the comparison.
async function current(relative: string): Promise<CompareSide | null> {
  const location = await safeResolve(relative, { mustExist: false, followSymlink: false });
  const stat = await fs.lstat(location).catch(() => null);
  if (!stat) return null;
  const type: CompareItemType | null = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : null;
  if (!type) return { type: "file", size: -1, mtimeMs: -1, modified: "" };
  return { type, size: type === "directory" ? 0 : stat.size, mtimeMs: stat.mtimeMs, modified: stat.mtime.toISOString() };
}

// A folder's own time changes whenever something inside it does, so only its kind is checked.
const unchanged = (now: CompareSide | null, then: CompareSide | null) => now === null || then === null
  ? now === then
  : now.type === then.type && (now.type === "directory" || (now.size === then.size && now.mtimeMs === then.mtimeMs));

const join = (base: string, relative: string) => (base ? `${base}/${relative}` : relative);

/** Whether any of these items would replace something on the side it's copied to. */
export const replacesAny = (items: SyncItem[]) => items.some((item) => (item.to === "left" ? item.left : item.right) !== null);

/**
 * Copies the chosen differences across as a background job. Each item is first checked against the
 * comparison: anything changed since (on either side) is left alone. Something already on the side
 * it's copied to goes to the trash first, so nothing is lost; without the trash nothing is replaced.
 */
export async function startSyncJob(username: string, leftPath: string, rightPath: string, items: SyncItem[]) {
  // Both folders must exist inside the account's folder; each item is checked again as it's copied.
  const { left, right, close } = await openPair(leftPath, rightPath);
  await close();
  if (replacesAny(items) && !config.trashEnabled) throw new AppError("Protected trash is turned off, so nothing can be replaced", 409, "TRASH_DISABLED");
  const subject = items.length === 1 ? path.posix.basename(items[0].path) : `${items.length} items`;
  return startJob("sync", `Syncing ${subject}`, { done: 0, total: items.length, unit: "entries" }, async (report, signal) => {
    const copied: TransferResult[] & { skipped?: SyncSkip[] } = [];
    const skipped: SyncSkip[] = [];
    for (const [index, item] of items.entries()) {
      if (signal.aborted) throw Object.assign(new AppError("The sync was cancelled", 409, "JOB_CANCELLED"), { completed: Object.assign(copied, { skipped }) });
      report({ done: index, total: items.length, unit: "entries" });
      let relative = item.path;
      try {
        relative = normalizeRelative(item.path);
        if (!relative) throw new AppError("Choose items inside the folders", 400, "INVALID_PATH");
        const [fromBase, toBase] = item.to === "right" ? [left, right] : [right, left];
        const source = join(fromBase, relative);
        const target = join(toBase, relative);
        const [fromThen, toThen] = item.to === "right" ? [item.left, item.right] : [item.right, item.left];
        if (!fromThen || !unchanged(await current(source), fromThen) || !unchanged(await current(target), toThen)) {
          skipped.push({ path: relative, reason: "changed" });
          continue;
        }
        if (toThen) {
          await deleteEntries([target]);
          await rewriteLinkedPaths([{ from: target }], username);
        }
        const parent = path.posix.dirname(target);
        copied.push(...await copyOrMove([source], parent === "." ? "" : parent, false, { signal }));
      } catch (error) {
        if (signal.aborted) throw Object.assign(new AppError("The sync was cancelled", 409, "JOB_CANCELLED"), { completed: Object.assign(copied, { skipped }) });
        skipped.push({ path: relative, reason: "failed", message: error instanceof AppError ? error.message : "It couldn't be copied" });
        if (!(error instanceof AppError)) console.error("A sync item failed", error);
      }
    }
    report({ done: items.length, total: items.length, unit: "entries" });
    return Object.assign(copied, { skipped });
  }, async (job) => {
    await audit("fs.sync", { username, left, right, items: items.length, copied: job.transferred?.length ?? 0, skipped: job.skipped?.length || undefined, status: job.status, error: job.error });
  });
}
