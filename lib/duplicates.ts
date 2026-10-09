import crypto from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { ensureRoot, INTERNAL_NAMES, isUnchangedFile, normalizeRelative, replaceWithLink, safeResolve, trashIfUnchanged, verifyFileHandleWithinRoot, type FileIdentity, type LinkOutcome } from "./files";
import { AppError } from "./http";

// Finds files with identical contents under a folder. Files are grouped by size, groups narrowed by
// sampling a few blocks of each file, and only what still matches is read in full and hashed
// (SHA-256), so a reported group is a certain byte-for-byte match. Hard links to one file are the
// same data, not duplicates, and count once. Reading is one file at a time, so a scan of a large
// tree is slow but gentle; it can be cancelled.

export interface DuplicateCopy { path: string; modified: string; inode: string; links: number }
export interface DuplicateGroup { size: number; copies: DuplicateCopy[]; wastedBytes: number }
export interface DuplicateReport {
  folder: string;
  minBytes: number;
  generatedAt: string;
  durationMs: number;
  filesSeen: number;
  skipped: number;
  groups: DuplicateGroup[];
  wastedBytes: number;
}
export interface DuplicateProgress {
  phase: "listing" | "comparing" | "hashing";
  folder: string;
  filesSeen: number;
  directoriesSeen: number;
  candidates: number;
  bytesToHash: number;
  bytesHashed: number;
  elapsedMs: number;
}

type Seen = { relative: string; size: number; dev: number; ino: number; mtimeMs: number; nlink: number };

// Smaller files are left out: they free little space and would make reports enormous.
export const MIN_DUPLICATE_BYTES = 64 * 1024;
const SAMPLE_BYTES = 64 * 1024;
const READ_BYTES = 1024 * 1024;
const MAX_DEPTH = 256;

type Scan = { controller: AbortController; progress: DuplicateProgress; startedAt: number; promise: Promise<void> };
let scan: Scan | null = null;
let starting = false;
let lastReport: DuplicateReport | null = null;
// Each reported copy's identity when it was scanned, so a removal can check it hasn't changed since.
let reportFiles = new Map<string, FileIdentity>();
let lastError: string | null = null;

const cancelled = () => new AppError("The duplicate scan was cancelled", 409, "JOB_CANCELLED");
const inodeOf = (item: { dev: number; ino: number }) => `${item.dev}:${item.ino}`;

// Opens a file found by the walk, if it is still the same unchanged file inside the root.
async function openSeen(root: string, item: Seen): Promise<FileHandle | null> {
  const location = path.join(root, ...item.relative.split("/"));
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY).catch(() => null);
  if (!handle) return null;
  try {
    const { stat } = await verifyFileHandleWithinRoot(handle, location);
    if (stat.isFile() && stat.dev === item.dev && stat.ino === item.ino && stat.size === item.size && stat.mtimeMs === item.mtimeMs) return handle;
  } catch {
    // Changed or no longer inside the root.
  }
  await handle.close().catch(() => undefined);
  return null;
}

async function readAt(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

// A cheap fingerprint from the start, middle, and end of a file.
async function sampleHash(root: string, item: Seen) {
  const handle = await openSeen(root, item);
  if (!handle) return null;
  try {
    const hash = crypto.createHash("sha256");
    const length = Math.min(SAMPLE_BYTES, item.size);
    for (const position of new Set([0, Math.max(0, Math.floor(item.size / 2) - length / 2), Math.max(0, item.size - length)])) {
      hash.update(await readAt(handle, Math.floor(position), length));
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fullHash(root: string, item: Seen, progress: DuplicateProgress, signal: AbortSignal) {
  const handle = await openSeen(root, item);
  if (!handle) return null;
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    for (let position = 0; position < item.size;) {
      if (signal.aborted) throw cancelled();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_BYTES, item.size - position), position);
      if (!bytesRead) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      progress.bytesHashed += bytesRead;
    }
    // A file written to while it was read isn't reported.
    const after = await handle.stat();
    return after.mtimeMs === item.mtimeMs && after.size === item.size ? hash.digest("hex") : null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Splits items by a key, keeping only groups with at least two different files (not hard links).
function splitBy<T extends Seen>(items: T[], keyOf: (item: T) => string | null) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].filter((group) => new Set(group.map(inodeOf)).size > 1);
}

async function walk(folder: string, minBytes: number, progress: DuplicateProgress, signal: AbortSignal) {
  const root = await ensureRoot();
  const stateRelative = path.relative(root, path.resolve(config.stateDir)).split(path.sep).join("/");
  const isState = (relative: string) => stateRelative && !stateRelative.startsWith("..") && (relative === stateRelative || relative.startsWith(`${stateRelative}/`));
  const bySize = new Map<number, Seen[]>();
  let skipped = 0;
  const stack: Array<{ relative: string; depth: number }> = [{ relative: folder, depth: 0 }];
  while (stack.length) {
    if (signal.aborted) throw cancelled();
    const { relative, depth } = stack.pop()!;
    const location = relative ? path.join(root, ...relative.split("/")) : root;
    // Each folder is opened without following a link and checked to be inside the root.
    const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) {
      skipped += 1;
      continue;
    }
    let names: string[] = [];
    let base = location;
    try {
      await verifyFileHandleWithinRoot(handle, location);
      base = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : location;
      names = await fs.readdir(base);
      progress.directoriesSeen += 1;
      for (const name of names) {
        if (INTERNAL_NAMES.has(name)) continue;
        const childRelative = relative ? `${relative}/${name}` : name;
        if (isState(childRelative)) continue;
        const stat = await fs.lstat(path.join(base, name)).catch(() => null);
        if (!stat) {
          skipped += 1;
        } else if (stat.isDirectory()) {
          if (depth < MAX_DEPTH) stack.push({ relative: childRelative, depth: depth + 1 });
          else skipped += 1;
        } else if (stat.isFile()) {
          progress.filesSeen += 1;
          if (stat.size >= minBytes && stat.size > 0) {
            const item = { relative: childRelative, size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, nlink: stat.nlink };
            const group = bySize.get(stat.size);
            if (group) group.push(item);
            else bySize.set(stat.size, [item]);
          }
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "JOB_CANCELLED") throw error;
      skipped += 1;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return { root, bySize, skipped };
}

async function findDuplicates(folder: string, minBytes: number, progress: DuplicateProgress, signal: AbortSignal, startedAt: number): Promise<{ report: DuplicateReport; files: Map<string, FileIdentity> }> {
  const files = new Map<string, FileIdentity>();
  const { root, bySize, skipped: walkSkipped } = await walk(folder, minBytes, progress, signal);
  let skipped = walkSkipped;
  const sizeGroups = [...bySize.values()].filter((group) => new Set(group.map(inodeOf)).size > 1);
  progress.phase = "comparing";
  progress.candidates = sizeGroups.reduce((total, group) => total + group.length, 0);

  // Sample one path per inode; hard links share the result.
  const sampled: Seen[][] = [];
  for (const group of sizeGroups) {
    const hashes = new Map<string, string | null>();
    for (const item of group) {
      if (signal.aborted) throw cancelled();
      const inode = inodeOf(item);
      if (!hashes.has(inode)) hashes.set(inode, await sampleHash(root, item));
    }
    skipped += [...hashes.values()].filter((value) => value === null).length;
    sampled.push(...splitBy(group, (item) => hashes.get(inodeOf(item)) ?? null));
  }

  progress.phase = "hashing";
  progress.bytesToHash = sampled.reduce((total, group) => total + group[0].size * new Set(group.map(inodeOf)).size, 0);
  const groups: DuplicateGroup[] = [];
  for (const group of sampled) {
    const hashes = new Map<string, string | null>();
    for (const item of group) {
      const inode = inodeOf(item);
      if (!hashes.has(inode)) hashes.set(inode, await fullHash(root, item, progress, signal));
    }
    skipped += [...hashes.values()].filter((value) => value === null).length;
    for (const matching of splitBy(group, (item) => hashes.get(inodeOf(item)) ?? null)) {
      for (const item of matching) files.set(item.relative, { dev: item.dev, ino: item.ino, size: item.size, mtimeMs: item.mtimeMs });
      const copies = matching
        .map((item) => ({ path: item.relative, modified: new Date(item.mtimeMs).toISOString(), inode: inodeOf(item), links: item.nlink }))
        .sort((a, b) => a.modified.localeCompare(b.modified) || a.path.localeCompare(b.path));
      groups.push({ size: matching[0].size, copies, wastedBytes: matching[0].size * (new Set(copies.map((copy) => copy.inode)).size - 1) });
    }
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || a.copies[0].path.localeCompare(b.copies[0].path));
  const report = {
    folder,
    minBytes,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    filesSeen: progress.filesSeen,
    skipped,
    groups,
    wastedBytes: groups.reduce((total, group) => total + group.wastedBytes, 0),
  };
  return { report, files };
}

/** Starts scanning a folder for duplicates; one scan runs at a time. */
export async function startDuplicateScan(folderPath: string, minBytes: number) {
  // The slot is claimed before anything is awaited, so two requests can't both start a scan.
  if (scan || starting) throw new AppError("A duplicate scan is already running", 409, "JOB_RUNNING");
  starting = true;
  let folder: string;
  try {
    if (!Number.isInteger(minBytes) || minBytes < MIN_DUPLICATE_BYTES) throw new AppError("Choose a minimum file size of at least 64 KB", 400, "INVALID_REQUEST");
    folder = normalizeRelative(folderPath).replace(/\/+$/, "");
    const absolute = await safeResolve(folder);
    if (!(await fs.stat(absolute)).isDirectory()) throw new AppError("Path is not a folder", 400, "NOT_A_DIRECTORY");
  } finally {
    starting = false;
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const progress: DuplicateProgress = { phase: "listing", folder, filesSeen: 0, directoriesSeen: 0, candidates: 0, bytesToHash: 0, bytesHashed: 0, elapsedMs: 0 };
  lastError = null;
  const current: Scan = { controller, progress, startedAt, promise: Promise.resolve() };
  current.promise = findDuplicates(folder, minBytes, progress, controller.signal, startedAt)
    .then(({ report, files }) => {
      lastReport = report;
      reportFiles = files;
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.error(error);
      lastError = error instanceof AppError ? error.message : "The duplicate scan failed unexpectedly";
    })
    .finally(() => { if (scan === current) scan = null; });
  scan = current;
}

export function cancelDuplicateScan() {
  scan?.controller.abort();
}

/** The running scan's progress, and the last finished report (groups paged, most space first). */
export function duplicateStatus({ offset = 0, limit = 200 }: { offset?: number; limit?: number } = {}) {
  const report = lastReport && { ...lastReport, totalGroups: lastReport.groups.length, groups: lastReport.groups.slice(offset, offset + limit) };
  return {
    scanning: scan ? { ...scan.progress, elapsedMs: Date.now() - scan.startedAt } : null,
    report,
    error: lastError,
  };
}

/**
 * Moves chosen copies to the trash. Call with the filesystem lock held, so the checks and the
 * removals can't interleave with another request. Each copy must be in the last report and still be
 * exactly the file scanned (same identity, size, and time, at its real location); one that changed
 * is skipped. Every set must keep at least one unchanged copy on disk. The report is updated as
 * each copy goes.
 */
export async function trashDuplicates(paths: string[]) {
  const removing = checkDuplicateRemoval(paths);
  const removingSet = new Set(removing);
  for (const group of lastReport!.groups) {
    if (!group.copies.some((copy) => removingSet.has(copy.path))) continue;
    let kept = false;
    for (const copy of group.copies) {
      const identity = reportFiles.get(copy.path);
      if (!removingSet.has(copy.path) && identity && await isUnchangedFile(copy.path, identity)) {
        kept = true;
        break;
      }
    }
    if (!kept) throw new AppError(`No unchanged copy of ${path.posix.basename(group.copies[0].path)} would be left; scan again`, 409, "KEEP_ONE_COPY");
  }
  const trashed: Array<{ path: string; id: string }> = [];
  const changed: string[] = [];
  try {
    for (const item of removing) {
      const identity = reportFiles.get(item);
      const id = identity ? await trashIfUnchanged(item, identity) : null;
      if (id) trashed.push({ path: item, id });
      else changed.push(item);
    }
  } finally {
    forgetDuplicatePaths([...trashed.map((item) => item.path), ...changed]);
  }
  return { trashed, changed };
}

export type LinkSkip = { path: string; reason: Exclude<LinkOutcome, { linked: true }>["reason"] };

/**
 * Replaces chosen copies with hard links to a kept copy of the same set: the oldest copy not
 * chosen that is still unchanged on disk. Each replaced copy goes to the protected trash. Call
 * with the filesystem lock held. Copies that changed, or whose owner or permissions differ from
 * the kept copy's, are skipped and reported. The report then shows the linked copies as one file.
 */
export async function linkDuplicates(paths: string[]) {
  const linking = new Set(checkDuplicateRemoval(paths));
  const plans: Array<{ group: DuplicateGroup; target: DuplicateCopy; copies: DuplicateCopy[] }> = [];
  for (const group of lastReport!.groups) {
    const chosen = group.copies.filter((copy) => linking.has(copy.path));
    if (!chosen.length) continue;
    let target: DuplicateCopy | null = null;
    for (const copy of group.copies) {
      const identity = reportFiles.get(copy.path);
      if (!linking.has(copy.path) && identity && await isUnchangedFile(copy.path, identity)) {
        target = copy;
        break;
      }
    }
    if (!target) throw new AppError(`No unchanged copy of ${path.posix.basename(group.copies[0].path)} is left to link to; scan again`, 409, "KEEP_ONE_COPY");
    plans.push({ group, target, copies: chosen });
  }
  const linked: Array<{ path: string; target: string; trashId: string }> = [];
  const skipped: LinkSkip[] = [];
  for (const plan of plans) {
    const targetIdentity = reportFiles.get(plan.target.path)!;
    for (const copy of plan.copies) {
      // A copy already linked to the kept file shares its data, so there is nothing to do.
      if (copy.inode === plan.target.inode) continue;
      const outcome = await replaceWithLink(copy.path, reportFiles.get(copy.path)!, plan.target.path, targetIdentity);
      if (outcome.linked) {
        linked.push({ path: copy.path, target: plan.target.path, trashId: outcome.trashId });
        Object.assign(copy, { inode: plan.target.inode, modified: plan.target.modified, links: plan.target.links + 1 });
        reportFiles.set(copy.path, targetIdentity);
      } else {
        skipped.push({ path: copy.path, reason: outcome.reason });
      }
    }
  }
  // Linked copies share the kept file's data now; sets left without an extra copy drop out.
  const groups = lastReport!.groups
    .map((group) => ({ ...group, wastedBytes: group.size * Math.max(0, new Set(group.copies.map((copy) => copy.inode)).size - 1) }))
    .filter((group) => group.wastedBytes > 0);
  lastReport = { ...lastReport!, groups, wastedBytes: groups.reduce((total, group) => total + group.wastedBytes, 0) };
  return { linked, skipped };
}

/**
 * Checks that removing `paths` leaves every group with at least one copy, and that each path is a
 * copy in the last report. Returns the normalized paths.
 */
export function checkDuplicateRemoval(paths: string[]) {
  if (!lastReport) throw new AppError("Scan for duplicates first", 409, "NO_REPORT");
  const removing = new Set(paths.map((item) => normalizeRelative(item).replace(/\/+$/, "")));
  const known = new Set(lastReport.groups.flatMap((group) => group.copies.map((copy) => copy.path)));
  for (const item of removing) {
    if (!known.has(item)) throw new AppError("That file isn't in the duplicate report; scan again", 409, "NOT_A_DUPLICATE");
  }
  for (const group of lastReport.groups) {
    if (group.copies.every((copy) => removing.has(copy.path))) {
      throw new AppError(`Keep at least one copy of ${path.posix.basename(group.copies[0].path)}`, 400, "KEEP_ONE_COPY");
    }
  }
  return [...removing];
}

/** Forgets removed paths, so the report stays accurate after copies are deleted. */
export function forgetDuplicatePaths(paths: string[]) {
  if (!lastReport || !paths.length) return;
  const removed = new Set(paths.map((item) => normalizeRelative(item).replace(/\/+$/, "")));
  // A copy goes if it, or any folder above it, was removed.
  const gone = (copyPath: string) => {
    for (let end = copyPath.length; end > 0; end = copyPath.lastIndexOf("/", end - 1)) {
      if (removed.has(copyPath.slice(0, end))) return true;
    }
    return false;
  };
  for (const item of removed) reportFiles.delete(item);
  const groups = lastReport.groups
    .map((group) => {
      const copies = group.copies.filter((copy) => !gone(copy.path));
      return { ...group, copies, wastedBytes: group.size * Math.max(0, new Set(copies.map((copy) => copy.inode)).size - 1) };
    })
    .filter((group) => group.wastedBytes > 0);
  lastReport = { ...lastReport, groups, wastedBytes: groups.reduce((total, group) => total + group.wastedBytes, 0) };
}

/** For tests: waits for the running scan, if any. */
export async function waitForDuplicateScan() {
  await scan?.promise;
}
