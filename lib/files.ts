import fs from "node:fs/promises";
import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { AppError } from "./http";
import { forgetCopies, readCopyJournal, recordCopy } from "./copy-journal";
import { replaceWithPattern } from "./safe-regex";
import { currentScope, runUnscoped, scopeRoot, withinScope } from "./scope";

// An account confined to a folder can't rename, move, or delete that folder itself.
function assertNotHome(relativePath: string) {
  const home = scopeRoot();
  if (home && relativePath.replace(/\/+$/, "") === home) throw new AppError("You can't rename, move, or delete your home folder", 403, "HOME_FOLDER");
}

// Confined accounts only see trash items deleted from inside their folder; the owner sees all,
// including items trashed before origins were recorded.
function trashItemVisible(originalPath: string | null) {
  const scope = currentScope();
  if (!scope || scope.role === "owner") return true;
  return originalPath !== null && withinScope(originalPath, scope.root);
}
import type { BulkRenameRule, DeleteResult, DiskInfo, EntryType, FileEntry, IdentityOption, JobProgress, LargestFilesResult, LargestFilesScanning, OwnershipPair, RenamePreview, TransferResult, TrashItem, TrashListing, TrashRestoreResult } from "./types";
import { canChangeOwnership } from "./privileges";

export const INTERNAL_NAMES = new Set([".filedude"]);
const mimeTypes: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".js": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".css": "text/css", ".html": "text/html", ".log": "text/plain",
  ".xml": "text/xml", ".yml": "text/yaml", ".yaml": "text/yaml", ".sh": "text/x-shellscript",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
};

let identitiesCache: { users: Map<number, string>; groups: Map<number, string>; at: number } | null = null;
let canonicalRoot: string | null = null;
let largestFilesCache: { at: number; index: LargestFilesIndex } | null = null;
let largestFilesScan: { promise: Promise<LargestFilesIndex>; progress: LargestScanProgress } | null = null;
let filesystemQueue: Promise<void> = Promise.resolve();

export async function acquireFilesystemLock() {
  startRecovery();
  let release!: () => void;
  const previous = filesystemQueue;
  filesystemQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      release();
    }
  };
}

export async function withFilesystemLock<T>(operation: () => Promise<T>) {
  const release = await acquireFilesystemLock();
  try {
    return await operation();
  } finally {
    release();
  }
}

export function getMime(filePath: string) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function normalizeRelative(input = "") {
  if (input.includes("\0")) throw new AppError("Invalid path", 400, "INVALID_PATH");
  const clean = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(clean);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new AppError("Path leaves the configured root", 403, "PATH_OUTSIDE_ROOT");
  }
  return normalized;
}

// Inside the configured root and, for a signed-in account confined to a folder, inside that folder.
// Everything that resolves or verifies a path goes through here, so confinement can't be bypassed
// by a symlink inside the account's folder pointing elsewhere in the root.
function insideRoot(candidate: string) {
  const root = canonicalRoot || config.root;
  const scoped = scopeRoot();
  const base = scoped ? path.join(root, ...scoped.split("/")) : root;
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

export async function ensureRoot() {
  await fs.mkdir(config.root, { recursive: true });
  canonicalRoot = await fs.realpath(config.root);
  return canonicalRoot;
}

export async function safeResolve(input = "", options: { mustExist?: boolean; allowInternal?: boolean; followSymlink?: boolean } = {}) {
  const relative = normalizeRelative(input);
  if (!withinScope(relative.replace(/\/+$/, ""))) throw new AppError("That location is outside your folder", 403, "OUTSIDE_SCOPE");
  if (!options.allowInternal && relative.split("/").some((part) => INTERNAL_NAMES.has(part))) {
    throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
  }

  const root = await ensureRoot();
  const candidate = path.resolve(root, relative);
  if (!insideRoot(candidate)) throw new AppError("Path leaves the configured root", 403, "PATH_OUTSIDE_ROOT");
  const stateRelative = path.relative(config.root, config.stateDir);
  if (!options.allowInternal && stateRelative !== "" && stateRelative !== ".." && !stateRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(stateRelative)) {
    const stateDirectory = path.resolve(root, stateRelative);
    if (candidate === stateDirectory || candidate.startsWith(`${stateDirectory}${path.sep}`)) {
      throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
    }
  }

  try {
    if (options.followSymlink === false) {
      await fs.lstat(candidate);
      const parent = await fs.realpath(path.dirname(candidate));
      if (!insideRoot(parent)) throw new AppError("Parent folder leaves the configured root", 403, "PATH_OUTSIDE_ROOT");
      return candidate;
    }
    const real = await fs.realpath(candidate);
    if (!insideRoot(real)) throw new AppError("Symlink leaves the configured root", 403, "SYMLINK_OUTSIDE_ROOT");
    return candidate;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
    if (options.mustExist !== false) throw new AppError("File or folder not found", 404, "NOT_FOUND");

    const parent = await fs.realpath(path.dirname(candidate));
    if (!insideRoot(parent)) throw new AppError("Parent folder leaves the configured root", 403, "PATH_OUTSIDE_ROOT");
    return candidate;
  }
}

async function openedHandlePath(handle: FileHandle, absolute: string) {
  if (process.platform === "linux") {
    try {
      return await fs.realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      throw new AppError("FilesDude could not verify the opened file", 503, "FILE_VERIFICATION_FAILED");
    }
  }
  return fs.realpath(absolute);
}

export async function verifyFileHandleWithinRoot(handle: FileHandle, absolute: string) {
  const openedPath = await openedHandlePath(handle, absolute);
  if (!insideRoot(openedPath)) throw new AppError("Opened file leaves the configured root", 403, "PATH_OUTSIDE_ROOT");
  return { openedPath, stat: await handle.stat() };
}

// O_NONBLOCK keeps a FIFO or device from blocking the open (which may run under the global lock);
// callers then refuse anything that is not a regular file or folder.
export async function openVerifiedFile(relativePath: string, access: "read" | "write" = "read") {
  const absolute = await safeResolve(relativePath);
  // Only files and folders are opened: opening a device or pipe can itself do something.
  const kind = await fs.stat(absolute).catch(() => null);
  if (kind && !kind.isFile() && !kind.isDirectory()) throw new AppError("Only files and folders can be opened", 400, "NOT_A_FILE");
  const handle = await fs.open(absolute, (access === "write" ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, absolute);
    return { absolute, handle, openedPath, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

// Quick operations work through open folder handles, as archives do (see lib/archives.ts): a path
// is checked once, its folder is opened and verified, and every later step names entries relative
// to that open folder (/proc/self/fd/N on Linux). Swapping a path component for a symlink part-way
// through then can't redirect the work outside the root or the account's folder. Walks below an
// open folder never follow symlinks. Elsewhere `base` is the folder's real path (development only).
export type AnchoredDirectory = { handle: FileHandle; base: string; real: string; stat: Stats };

const ON_LINUX = process.platform === "linux";
// Deeper trees are refused by delete and copy, which hold one handle per level.
const MAX_TREE_DEPTH = 256;

function openFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new AppError("File or folder not found", 404, "NOT_FOUND");
  if (code === "ENOTDIR") throw new AppError("Path is not a folder", 400, "NOT_A_DIRECTORY");
  if (code === "ELOOP") throw new AppError("That location changed while it was being opened", 409, "PATH_CHANGED");
  throw error;
}

export async function isReservedLocation(real: string) {
  if (path.relative(canonicalRoot || config.root, real).split(path.sep).some((part) => INTERNAL_NAMES.has(part))) return true;
  const state = await fs.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
  return real === state || real.startsWith(`${state}${path.sep}`);
}

async function openAnchored(location: string, { follow, checkReserved }: { follow: boolean; checkReserved: boolean }): Promise<AnchoredDirectory> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW);
  const handle = await fs.open(location, flags).catch(openFailure);
  try {
    const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, location);
    if (checkReserved && (await isReservedLocation(openedPath))) throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
    return { handle, base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : openedPath, real: openedPath, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function inside(directory: AnchoredDirectory, name: string) {
  return path.join(directory.base, name);
}

/** Opens a folder the account can reach; symlinks on the way are followed, then the result verified. */
export async function openDirectory(relativePath: string) {
  const absolute = await safeResolve(relativePath);
  return openAnchored(absolute, { follow: true, checkReserved: true });
}

function openChild(directory: AnchoredDirectory, name: string, checkReserved = false) {
  return openAnchored(inside(directory, name), { follow: false, checkReserved });
}

// A folder this service just made: owned by it, with nothing in it yet, and with `mode` if given.
async function isFreshFolder(folder: AnchoredDirectory, mode?: number) {
  if (typeof process.getuid === "function" && folder.stat.uid !== process.getuid()) return false;
  if (mode !== undefined && (folder.stat.mode & 0o7777) !== mode) return false;
  return (await fs.readdir(folder.base)).length === 0;
}

function tooDeep(depth: number) {
  if (depth > MAX_TREE_DEPTH) throw new AppError(`Folders nested more than ${MAX_TREE_DEPTH} levels deep can't be copied or deleted here`, 400, "TREE_TOO_DEEP");
}

// FilesDude's own trash folders, already checked by trashDirectories() and writable only by root.
async function openTrashFolder(location: string): Promise<AnchoredDirectory> {
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return { handle, base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : location, real: location, stat: await handle.stat() };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

// A folder inside a ZFS snapshot. Snapshots are read-only, so a folder checked once can't change;
// children are opened without following links.
async function openSnapshotFolder(location: string): Promise<AnchoredDirectory> {
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(openFailure);
  try {
    const real = await openedHandlePath(handle, location);
    if (real !== location) throw new AppError("That snapshot folder isn't where it should be", 409, "PATH_CHANGED");
    return { handle, base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : location, real, stat: await handle.stat() };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openSnapshotChild(directory: AnchoredDirectory, name: string) {
  return openSnapshotFolder(path.join(directory.real, name));
}

export async function withOpen<T>(opening: Promise<AnchoredDirectory>, run: (directory: AnchoredDirectory) => Promise<T>) {
  const directory = await opening;
  try {
    return await run(directory);
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

const cleanRelative = (input: string) => normalizeRelative(input).replace(/\/+$/, "");
const parentOf = (relative: string) => (path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
const childOf = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

function missingAsNull(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

/** Runs `run` with the item's open, verified parent folder and the item's name in it. */
async function withParent<T>(relativePath: string, run: (parent: AnchoredDirectory, name: string, relative: string) => Promise<T>) {
  const relative = cleanRelative(relativePath);
  if (!relative) throw new AppError("The configured root can't be changed this way", 403, "ROOT_PATH");
  await safeResolve(relative, { followSymlink: false });
  return withOpen(openDirectory(parentOf(relative)), (parent) => run(parent, path.posix.basename(relative), relative));
}

/** Removes `name` only if it is still the file that was created there. */
export async function removeIfSame(directory: AnchoredDirectory, name: string, created: Stats) {
  const current = await fs.lstat(inside(directory, name)).catch(() => null);
  if (current && current.ino === created.ino && current.dev === created.dev) await fs.unlink(inside(directory, name)).catch(() => undefined);
}

/**
 * Removes `name` from `directory`; folders are emptied through their own handles, never by path.
 * Entries that disappear meanwhile count as removed.
 */
async function removeEntry(directory: AnchoredDirectory, name: string, depth = 0) {
  tooDeep(depth);
  const location = inside(directory, name);
  const stat = await fs.lstat(location).catch(missingAsNull);
  if (!stat) return;
  if (!stat.isDirectory()) return fs.unlink(location);
  await withOpen(openChild(directory, name), async (folder) => {
    for (const entry of await fs.readdir(folder.base)) await removeEntry(folder, entry, depth + 1);
  });
  await fs.rmdir(location);
}

/** Device and inode as share links store them, for following items a move had to copy. */
export type ItemIdentity = { dev: string; ino: string };
export type CopiedItems = ReadonlyMap<string, ItemIdentity>;

// What a copy carries through its walk: folders it made (so it never copies into itself), a way to
// stop it, and a running count of bytes for progress. For a move that will remove the original,
// `sources` collects what was copied unchanged and `copies` maps each such original's identity to
// its copy's. `top` identifies the item the copy created and `created` is told (and awaited) as soon
// as it exists; `moved` is told about each item a move puts in place, under the lock.
type CopyContext = {
  made: Set<string>;
  signal?: AbortSignal;
  copied?: (bytes: number) => void;
  sources?: Set<string>;
  copies?: Map<string, ItemIdentity>;
  top?: string;
  topBirth?: string;
  created?: () => Promise<void>;
  moved?: (item: TransferResult, copies?: CopiedItems) => Promise<void>;
  /** The source can't change (a ZFS snapshot), so its folders are opened without the root check. */
  sourceIsSnapshot?: boolean;
};

const itemIdentityOf = (stat: BigIntStats): ItemIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const itemKey = (identity: ItemIdentity) => `${identity.dev}:${identity.ino}`;

export const identityOf = (stat: Stats) => `${stat.dev}:${stat.ino}`;
// What a move may remove once copied: folders by identity, anything else by identity, size, and
// modification and change times, so a file changed after (or while) it was copied is kept.
const fingerprintOf = (stat: BigIntStats) => (stat.isDirectory()
  ? `d:${stat.dev}:${stat.ino}`
  : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);

async function markCreated(context: CopyContext, depth: number, stat: BigIntStats) {
  if (depth !== 0) return;
  context.top = `${stat.dev}:${stat.ino}`;
  context.topBirth = String(stat.birthtimeNs);
  await context.created?.();
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppError("The job was cancelled", 409, "JOB_CANCELLED");
}

async function copyContents(input: FileHandle, output: FileHandle, context: CopyContext) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let position = 0; ;) {
    throwIfCancelled(context.signal);
    const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    context.copied?.(bytesRead);
    for (let written = 0; written < bytesRead;) {
      written += (await output.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
    }
    position += bytesRead;
  }
}

// Copies keep each item's permissions (without setuid/setgid) and, when FilesDude can change owners,
// its owner, like `cp -a`. Attributes are applied through the new item's own handle, and a folder
// is only used once it is confirmed to be the one this copy just made. Special files are refused.
async function applyCopiedAttributes(handle: FileHandle, source: Stats) {
  if (canChangeOwnership()) await handle.chown(source.uid, source.gid);
  await handle.chmod(source.mode & 0o1777);
}

async function copyEntry(from: AnchoredDirectory, name: string, to: AnchoredDirectory, targetName: string, context: CopyContext, depth = 0) {
  tooDeep(depth);
  throwIfCancelled(context.signal);
  const source = inside(from, name);
  const target = inside(to, targetName);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const before = context.sources && fingerprintOf(await fs.lstat(source, { bigint: true }));
    await fs.symlink(await fs.readlink(source), target);
    // Only a link that wasn't replaced while it was read may be removed by a move.
    if (before && before === fingerprintOf(await fs.lstat(source, { bigint: true }))) context.sources!.add(before);
    if (depth === 0) await markCreated(context, depth, await fs.lstat(target, { bigint: true }));
    return;
  }
  if (stat.isDirectory()) {
    // A folder this copy made that was moved into the source meanwhile; copying it would never end.
    if (context.made.has(identityOf(stat))) return;
    await fs.mkdir(target, 0o700);
    await withOpen(openChild(to, targetName), async (created) => {
      if (!(await isFreshFolder(created, 0o700))) {
        throw new AppError("The destination changed while it was being copied to", 409, "PATH_CHANGED");
      }
      context.made.add(identityOf(created.stat));
      await markCreated(context, depth, await created.handle.stat({ bigint: true }));
      const original = await withOpen(context.sourceIsSnapshot ? openSnapshotChild(from, name) : openChild(from, name), async (folder) => {
        if (context.sources) {
          const folderStat = await folder.handle.stat({ bigint: true });
          context.sources.add(fingerprintOf(folderStat));
          context.copies?.set(itemKey(itemIdentityOf(folderStat)), itemIdentityOf(await created.handle.stat({ bigint: true })));
        }
        for (const entry of await fs.readdir(folder.base)) await copyEntry(folder, entry, created, entry, context, depth + 1);
        return folder.stat;
      });
      await applyCopiedAttributes(created.handle, original);
    });
    return;
  }
  const special = new AppError(`${name} is a special file and can't be copied`, 400, "SPECIAL_FILE");
  if (!stat.isFile()) throw special;
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const opened = await input.stat();
    if (!opened.isFile()) throw special;
    const beforeStat = context.sources && await input.stat({ bigint: true });
    const before = beforeStat && fingerprintOf(beforeStat);
    const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await markCreated(context, depth, await output.stat({ bigint: true }));
      await copyContents(input, output, context);
      await applyCopiedAttributes(output, opened);
      // Only a file that didn't change while it was copied may be removed by a move, and only then
      // do links to it follow the copy.
      if (before && before === fingerprintOf(await input.stat({ bigint: true }))) {
        context.sources!.add(before);
        // A file with several hard links becomes separate copies, so links to it can't follow one.
        if (beforeStat.nlink === BigInt(1)) context.copies?.set(itemKey(itemIdentityOf(beforeStat)), itemIdentityOf(await output.stat({ bigint: true })));
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/**
 * Removes what a move copied from `name`, keeping anything that wasn't copied unchanged (added or
 * changed by other processes while the copy ran). Returns whether everything was removed.
 */
async function removeCopied(directory: AnchoredDirectory, name: string, sources: Set<string>, depth = 0): Promise<boolean> {
  tooDeep(depth);
  const location = inside(directory, name);
  const stat = await fs.lstat(location, { bigint: true }).catch(missingAsNull);
  if (!stat) return true;
  if (!sources.has(fingerprintOf(stat))) return false;
  if (!stat.isDirectory()) {
    await fs.unlink(location);
    return true;
  }
  let complete = true;
  await withOpen(openChild(directory, name), async (folder) => {
    if (!sources.has(fingerprintOf(await folder.handle.stat({ bigint: true })))) {
      complete = false;
      return;
    }
    for (const entry of await fs.readdir(folder.base)) complete = (await removeCopied(folder, entry, sources, depth + 1)) && complete;
  });
  if (!complete) return false;
  try {
    await fs.rmdir(location);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" || (error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Removes the item a copy created at `name`. A folder is checked through the same handle that is
 * then emptied, so an item swapped in at that name is never emptied, and the final rmdir by name
 * fails harmlessly if the name now holds something else.
 */
export async function removeCreated(directory: AnchoredDirectory, name: string, created: string | undefined) {
  if (!created) return;
  const stat = await fs.lstat(inside(directory, name)).catch(missingAsNull);
  if (!stat || identityOf(stat) !== created) return;
  if (!stat.isDirectory()) {
    await fs.unlink(inside(directory, name));
    return;
  }
  const emptied = await withOpen(openChild(directory, name), async (folder) => {
    if (identityOf(folder.stat) !== created) return false;
    for (const entry of await fs.readdir(folder.base)) await removeEntry(folder, entry, 1);
    return true;
  });
  if (emptied) await fs.rmdir(inside(directory, name)).catch(() => undefined);
}

const nameConflict = () => new AppError("An item with that name already exists in the destination", 409, "NAME_CONFLICT");

/**
 * Puts `name` from one open folder at `targetName` in another without replacing anything there.
 * Files (and, on Linux, links) are hard-linked and then unlinked, which fails if the name is taken;
 * if the original was replaced in between, the replacement is left alone. Folders, and files on
 * filesystems without hard links, are renamed after checking the name is free, so only something
 * created in that moment could be replaced.
 */
export async function placeEntry(from: AnchoredDirectory, name: string, to: AnchoredDirectory, targetName: string) {
  const source = inside(from, name);
  const target = inside(to, targetName);
  const stat = await fs.lstat(source);
  if (stat.isFile() || (ON_LINUX && stat.isSymbolicLink())) {
    try {
      await fs.link(source, target);
      const [current, placed] = await Promise.all([fs.lstat(source).catch(missingAsNull), fs.lstat(target)]);
      if (current && identityOf(current) === identityOf(placed)) await fs.unlink(source);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw nameConflict();
      if (code === "EXDEV" || !["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].includes(code ?? "")) throw error;
    }
  }
  if (await fs.lstat(target).catch(missingAsNull)) throw nameConflict();
  await fs.rename(source, target);
}

async function moveEntry(from: AnchoredDirectory, name: string, to: AnchoredDirectory, targetName: string) {
  try {
    await fs.rename(inside(from, name), inside(to, targetName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyEntry(from, name, to, targetName, { made: new Set() });
    await removeEntry(from, name);
  }
}

export function relativeFromAbsolute(absolute: string) {
  return path.relative(canonicalRoot || config.root, absolute).split(path.sep).join("/");
}

// Every item in a listing asks for the account names at once: they share one reading of the files.
type Identities = { users: Map<number, string>; groups: Map<number, string>; at: number };
let identitiesLoading: Promise<Identities> | null = null;

async function identities(): Promise<Identities> {
  if (identitiesCache && Date.now() - identitiesCache.at < 60_000) return identitiesCache;
  identitiesLoading ??= loadIdentities().finally(() => { identitiesLoading = null; });
  return identitiesLoading;
}

async function loadIdentities(): Promise<Identities> {
  const users = new Map<number, string>();
  const groups = new Map<number, string>();
  try {
    const passwd = await fs.readFile("/etc/passwd", "utf8");
    passwd.split("\n").forEach((line) => {
      const parts = line.split(":");
      if (parts.length > 2) users.set(Number(parts[2]), parts[0]);
    });
    const group = await fs.readFile("/etc/group", "utf8");
    group.split("\n").forEach((line) => {
      const parts = line.split(":");
      if (parts.length > 2) groups.set(Number(parts[2]), parts[0]);
    });
  } catch {
    // Numeric ids remain useful on non-POSIX development hosts.
  }
  identitiesCache = { users, groups, at: Date.now() };
  return identitiesCache;
}

async function namedOwnership(uid: number, gid: number): Promise<OwnershipPair> {
  const ids = await identities();
  return {
    uid,
    gid,
    owner: ids.users.get(uid) || String(uid),
    group: ids.groups.get(gid) || String(gid),
  };
}

export async function identityCatalog(): Promise<{ users: IdentityOption[]; groups: IdentityOption[] }> {
  const ids = await identities();
  const sort = (a: IdentityOption, b: IdentityOption) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return {
    users: [...ids.users].map(([id, name]) => ({ id, name })).sort(sort),
    groups: [...ids.groups].map(([id, name]) => ({ id, name })).sort(sort),
  };
}

export async function isKnownIdentityPair(uid: number, gid: number) {
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) return false;
  const ids = await identities();
  return ids.users.has(uid) && ids.groups.has(gid);
}

export async function resolveOwnershipPair(uid: number, gid: number, source?: OwnershipPair["source"]) {
  return { ...(await namedOwnership(uid, gid)), source };
}

export async function uploadOwnershipOptions(relativePath = "") {
  const absolute = await safeResolve(relativePath);
  const directoryStat = await fs.stat(absolute);
  if (!directoryStat.isDirectory()) throw new AppError("Upload destination is not a folder", 400, "NOT_A_DIRECTORY");

  const names = await fs.readdir(absolute);
  const limit = 2_000;
  const samples = await Promise.allSettled(names.slice(0, limit).map((name) => fs.lstat(path.join(absolute, name))));
  const counts = new Map<string, { uid: number; gid: number; count: number }>();
  for (const sample of samples) {
    if (sample.status !== "fulfilled") continue;
    const key = `${sample.value.uid}:${sample.value.gid}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { uid: sample.value.uid, gid: sample.value.gid, count: 1 });
  }

  const destination = { ...(await namedOwnership(directoryStat.uid, directoryStat.gid)), source: "destination" as const };
  const detected = await Promise.all([...counts.values()].map(async (pair) => ({
    ...(await namedOwnership(pair.uid, pair.gid)),
    count: pair.count,
    source: pair.uid === destination.uid && pair.gid === destination.gid ? "destination" as const : "contents" as const,
  })));
  if (!detected.some((pair) => pair.uid === destination.uid && pair.gid === destination.gid)) {
    detected.unshift({ ...destination, count: 0 });
  }
  detected.sort((a, b) => {
    if (a.source === "destination" && b.source !== "destination") return -1;
    if (a.source !== "destination" && b.source === "destination") return 1;
    return (b.count || 0) - (a.count || 0) || a.owner.localeCompare(b.owner);
  });

  const serviceUid = typeof process.getuid === "function" ? process.getuid() : directoryStat.uid;
  const serviceGid = typeof process.getgid === "function" ? process.getgid() : directoryStat.gid;
  return {
    destination,
    detected,
    service: { ...(await namedOwnership(serviceUid, serviceGid)), source: "service" as const },
    canChangeOwnership: canChangeOwnership(),
    truncated: names.length > limit,
  };
}

export async function isAvailableUploadOwnership(relativePath: string, uid: number, gid: number, savedDefault?: { uid: number; gid: number }) {
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) return false;
  if (savedDefault?.uid === uid && savedDefault.gid === gid) return true;
  if (await isKnownIdentityPair(uid, gid)) return true;
  const options = await uploadOwnershipOptions(relativePath);
  return options.detected.some((pair) => pair.uid === uid && pair.gid === gid);
}

// `location` is where to look (usually inside an open folder); `relative` is the path shown to the user.
export async function toEntry(location: string, relative: string, name = path.posix.basename(relative), known?: Stats): Promise<FileEntry> {
  const stat = known ?? await fs.lstat(location);
  const ids = await identities();
  const type: FileEntry["type"] = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
  let symlinkTarget: string | undefined;
  let symlinkBlocked = false;

  if (type === "symlink") {
    symlinkTarget = await fs.readlink(location);
    try {
      const real = await fs.realpath(location);
      symlinkBlocked = !insideRoot(real);
    } catch {
      symlinkBlocked = true;
    }
  }

  return {
    name,
    path: relative,
    type,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    mode: (stat.mode & 0o7777).toString(8).padStart(3, "0"),
    uid: stat.uid,
    gid: stat.gid,
    owner: ids.users.get(stat.uid) || String(stat.uid),
    group: ids.groups.get(stat.gid) || String(stat.gid),
    mime: type === "file" ? getMime(name) : "inode/directory",
    hidden: name.startsWith("."),
    symlinkTarget,
    symlinkBlocked,
  };
}

export async function diskInfo(): Promise<DiskInfo> {
  const stat = await fs.statfs(await ensureRoot());
  const total = Number(stat.blocks) * Number(stat.bsize);
  const available = Number(stat.bavail) * Number(stat.bsize);
  return { total, available, used: total - available };
}

/**
 * A folder's items. The filesystem lock is only held to open the folder, which is then read through
 * its handle, so listing a folder of many thousands of items doesn't hold up everyone's changes.
 */
export async function listDirectory(relativePath = "", showHidden = false) {
  const relative = cleanRelative(relativePath);
  const release = await acquireFilesystemLock();
  let opened: AnchoredDirectory;
  try {
    opened = await openDirectory(relative);
  } finally {
    release();
  }
  const entries = await withOpen(Promise.resolve(opened), async (directory) => {
    const names = await fs.readdir(directory.base);
    const visible = names.filter((name) => !INTERNAL_NAMES.has(name) && (showHidden || !name.startsWith(".")));
    // A few at a time, so a folder of hundreds of thousands of items doesn't look at them all at once.
    const found: FileEntry[] = [];
    for (let start = 0; start < visible.length; start += LIST_BATCH) {
      found.push(...await Promise.all(visible.slice(start, start + LIST_BATCH).map((name) => toEntry(inside(directory, name), childOf(relative, name), name))));
    }
    return found;
  });
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path: normalizeRelative(relativePath), entries, disk: await diskInfo() };
}

/** Folders listed at most for one folder in the folder tree, and items read to find them. */
export const MAX_TREE_FOLDERS = 2_000;
const MAX_TREE_SCAN = 100_000;
const LIST_BATCH = 64;
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The folders directly inside a folder, by name, for the folder tree: read from the folder's own
 * listing (no look at each item, so a folder of thousands of files is quick), and only real folders
 * (not links to them). The filesystem lock is only held to open the folder, which is then read
 * through its handle, as searches are; reading stops after 100,000 items.
 */
export async function listFolders(relativePath = "", showHidden = false) {
  const relative = cleanRelative(relativePath);
  const release = await acquireFilesystemLock();
  let directory: AnchoredDirectory;
  try {
    directory = await openDirectory(relative);
  } finally {
    release();
  }
  const names: string[] = [];
  let scanned = 0;
  let truncated = false;
  try {
    for await (const item of await fs.opendir(directory.base)) {
      if (++scanned > MAX_TREE_SCAN) {
        truncated = true;
        break;
      }
      if (INTERNAL_NAMES.has(item.name) || (!showHidden && item.name.startsWith("."))) continue;
      let folder = item.isDirectory();
      if (!folder && !item.isFile() && !item.isSymbolicLink() && !item.isFIFO() && !item.isSocket() && !item.isBlockDevice() && !item.isCharacterDevice()) {
        // The filesystem didn't say what it is: look (without following links); one gone since is skipped.
        folder = await fs.lstat(inside(directory, item.name)).then((stat) => stat.isDirectory(), () => false);
      }
      if (folder) names.push(item.name);
    }
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
  names.sort(nameCollator.compare);
  return { path: relative, folders: names.slice(0, MAX_TREE_FOLDERS).map((name) => ({ name, path: childOf(relative, name) })), truncated: truncated || names.length > MAX_TREE_FOLDERS };
}

export function validateName(name: string) {
  // Invisible and direction-changing characters are replaced (see uploadName).
  const trimmed = name.replace(/[\p{Cc}\p{Cf}]/gu, "_").trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new AppError("Enter a valid name without slashes", 400, "INVALID_NAME");
  }
  if (INTERNAL_NAMES.has(trimmed)) throw new AppError("That name is reserved", 400, "RESERVED_NAME");
  if (Buffer.byteLength(trimmed) > 255) throw new AppError("That name is too long", 400, "NAME_TOO_LONG");
  return trimmed;
}

export const MAX_UPLOAD_FOLDER_DEPTH = 32;

/**
 * Opens the folders `names` inside `base`, one level at a time, creating any that don't exist (for
 * uploading a folder with its structure). Each level is made and opened inside the previous one's
 * open handle and never through a symlink, and checked against the account's folder and FilesDude's
 * reserved names. With `uniqueFirst`, the first folder is always new: "Photos (1)" if "Photos" is
 * taken (or is a link). New folders get `owner`, or with `inheritOwner` the owner of the folder each
 * is made in, as other new items do for confined accounts (when FilesDude can change owners). Returns the folder
 * (which the caller closes) and the paths of the folders this call made.
 */
export async function ensureFolders(base: AnchoredDirectory, baseRelative: string, names: string[], options: { owner?: { uid: number; gid: number } | null; inheritOwner?: boolean; uniqueFirst?: boolean } = {}) {
  if (!names.length) throw new AppError("Choose a folder", 400, "INVALID_FOLDER");
  if (names.length > MAX_UPLOAD_FOLDER_DEPTH) throw new AppError(`Folders nested more than ${MAX_UPLOAD_FOLDER_DEPTH} levels deep can't be uploaded`, 400, "TREE_TOO_DEEP");
  // Every name, and the whole path's length, is checked before anything is made, so a bad one
  // further down leaves nothing behind.
  const checked = names.map((raw) => {
    const name = validateName(raw);
    if (Buffer.byteLength(name, "utf8") > 255) throw new AppError("A folder name is too long", 400, "INVALID_NAME");
    return name;
  });
  if (Buffer.byteLength(path.join(base.real, ...checked), "utf8") + (options.uniqueFirst ? 8 : 0) > 3_800) throw new AppError("That folder path is too long", 400, "PATH_TOO_LONG");
  const made: string[] = [];
  let current = base;
  let relative = cleanRelative(baseRelative);
  // Makes the folder unless it exists; true if this call made it.
  const make = async (name: string) => {
    try {
      await fs.mkdir(inside(current, name));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code === "ENAMETOOLONG") throw new AppError("That folder path is too long", 400, "PATH_TOO_LONG");
      throw error;
    }
  };
  try {
    for (const [index, checkedName] of checked.entries()) {
      let name = checkedName;
      let created = false;
      const startedAt = Date.now();
      if (index === 0 && options.uniqueFirst) {
        for (let attempt = 0; ; attempt += 1) {
          if (attempt >= 1_000) throw new AppError("Unable to choose an available folder name", 409);
          name = attempt ? fitName(checkedName, ` (${attempt})`) : checkedName;
          try {
            await safeResolve(childOf(relative, name), { mustExist: false });
          } catch (error) {
            // A link with this name (pointing anywhere) just means the name is taken.
            if (error instanceof AppError && (error.code === "SYMLINK_OUTSIDE_ROOT" || error.code === "PATH_OUTSIDE_ROOT")) continue;
            throw error;
          }
          if ((created = await make(name))) break;
        }
      } else {
        await safeResolve(childOf(relative, name), { mustExist: false });
        created = await make(name);
      }
      // Opening without following links refuses a symlink (or a file) where a folder should be.
      const child = await openChild(current, name, true).catch((error: unknown) => {
        if (error instanceof AppError) throw error;
        throw new AppError(`“${name}” already exists and isn't a folder`, 409, "NOT_A_DIRECTORY");
      });
      const parent = current;
      current = child;
      relative = childOf(relative, name);
      if (created) made.push(relative);
      const owner = options.inheritOwner ? { uid: parent.stat.uid, gid: parent.stat.gid } : options.owner;
      if (parent !== base) await parent.handle.close().catch(() => undefined);
      // Only a folder this call just made is given away: empty, with no subfolders, and born after
      // the mkdir (so an existing empty folder swapped in under the name isn't).
      const fresh = created && child.stat.nlink === 2 && (!child.stat.birthtimeMs || child.stat.birthtimeMs >= startedAt - 1_000);
      if (fresh && owner && canChangeOwnership() && (await isFreshFolder(child))) {
        await child.handle.chown(owner.uid, owner.gid);
        // Its new owner is what the next level inherits.
        child.stat = await child.handle.stat();
      }
    }
    return { folder: current, relative, made };
  } catch (error) {
    if (current !== base) await current.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function createEntry(parentPath: string, name: string, type: "file" | "directory") {
  const parentRelative = cleanRelative(parentPath);
  const entryName = validateName(name);
  const relative = childOf(parentRelative, entryName);
  await safeResolve(relative, { mustExist: false });
  return withOpen(openDirectory(parentRelative), async (directory) => {
    const location = inside(directory, entryName);
    // Confined accounts' new items take the folder's owner, as their uploads do.
    const scope = currentScope();
    const owner = scope && scope.role !== "owner" && canChangeOwnership() ? directory.stat : null;
    if (type === "directory") {
      await fs.mkdir(location);
      if (owner) {
        await withOpen(openChild(directory, entryName), async (created) => {
          if (await isFreshFolder(created)) await created.handle.chown(owner.uid, owner.gid);
        });
      }
    } else {
      const handle = await fs.open(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      try {
        if (owner) await handle.chown(owner.uid, owner.gid);
      } finally {
        await handle.close();
      }
    }
    return toEntry(location, relative, entryName);
  });
}

export async function renameEntry(sourcePath: string, newName: string) {
  assertNotHome(cleanRelative(sourcePath));
  const newEntryName = validateName(newName);
  return withParent(sourcePath, async (parent, name, relative) => {
    const source = inside(parent, name);
    const target = inside(parent, newEntryName);
    const targetRelative = childOf(parentOf(relative), newEntryName);
    if (newEntryName === name) return toEntry(source, relative, name);
    await safeResolve(targetRelative, { mustExist: false });
    // lstat, not access/realpath: a symlink must never be mistaken for the file it points to, and a
    // dangling symlink at the target name still occupies it.
    const existing = await fs.lstat(target).catch(missingAsNull);
    if (!existing) {
      await fs.rename(source, target);
      return toEntry(target, targetRelative, newEntryName);
    }
    // On a case-insensitive filesystem a case-only rename finds the item itself under the new name.
    // A hardlink also shares the inode, so the names must differ only in case.
    const current = await fs.lstat(source);
    const caseOnly = newEntryName.toLowerCase() === name.toLowerCase() && existing.ino === current.ino && existing.dev === current.dev;
    if (!caseOnly) throw new AppError("An item with that name already exists", 409, "NAME_CONFLICT");
    const temporary = inside(parent, `.filedude-case-${crypto.randomUUID()}`);
    await fs.rename(source, temporary);
    await fs.rename(temporary, target);
    return toEntry(target, targetRelative, newEntryName);
  });
}

export async function deleteEntries(paths: string[], permanent = false): Promise<DeleteResult> {
  if (!paths.length) throw new AppError("Choose at least one item", 400);
  const trash = !permanent && config.trashEnabled ? await trashDirectories(true) : null;
  const trashed: DeleteResult["trashed"] = [];

  for (const relativePath of paths) {
    const relative = cleanRelative(relativePath);
    if (!relative) throw new AppError("The configured root cannot be deleted", 403);
    assertNotHome(relative);
    await withParent(relative, async (parent, name) => {
      if (trash) trashed.push({ path: relative, id: await moveToTrash(parent, name, relative, trash) });
      else await removeEntry(parent, name);
    });
  }
  return { trashed };
}

// Trashed items live in .filedude/trash/<id>, with a matching .filedude/trash-info/<id>.json
// recording where each came from. Items trashed before the info files existed were named
// "<original name>.<ms timestamp>-<6 hex>" and are restored to the root.
type TrashDirectories = { items: string; info: string };
type TrashInfo = { name: string; originalPath: string; type: EntryType; size: number; sizeComplete: boolean; deletedAt: string };

const LEGACY_TRASH_ID = /^(.+)\.(\d{13})-[0-9a-f]{6}$/;
const legacyTrashSizes = new Map<string, { bytes: number; complete: boolean }>();
const TRASH_MEASURE_LIMIT = 50_000;

function entryType(stat: { isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
  return stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
}

// Trash folders are FilesDude's own, and nobody else may write to them (other users may write to the root).
function privateToService(stat: { uid: number; mode: number }) {
  return (typeof process.getuid !== "function" || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

async function trashDirectories(create: true): Promise<TrashDirectories>;
async function trashDirectories(create?: boolean): Promise<TrashDirectories | null>;
async function trashDirectories(create = false) {
  const internal = path.join(await ensureRoot(), ".filedude");
  const directories = { items: path.join(internal, "trash"), info: path.join(internal, "trash-info") };
  const parent = await fs.lstat(internal).catch(() => null);
  if (parent && (!parent.isDirectory() || !privateToService(parent))) {
    throw new AppError("FilesDude's trash folder is not a regular folder inside the root", 500, "TRASH_UNSAFE");
  }
  for (const directory of Object.values(directories)) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if ((await fs.realpath(directory)) !== directory || !privateToService(await fs.lstat(directory))) {
        throw new AppError("FilesDude's trash folder is not a regular folder inside the root", 500, "TRASH_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (directory === directories.items) return null;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }
  return directories;
}

/** Totals file sizes below `absolute`, walking through open folder handles without following symlinks. */
export async function measureTree(absolute: string, signal?: AbortSignal) {
  let bytes = 0;
  let visited = 0;
  let complete = true;
  async function walk(location: string, depth: number) {
    throwIfCancelled(signal);
    if (visited >= TRASH_MEASURE_LIMIT || depth > MAX_TREE_DEPTH) {
      complete = false;
      return;
    }
    visited += 1;
    const stat = await fs.lstat(location).catch(() => null);
    if (!stat) {
      complete = false;
    } else if (stat.isFile()) {
      bytes += stat.size;
    } else if (stat.isDirectory()) {
      const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (!handle) {
        complete = false;
        return;
      }
      try {
        const base = ON_LINUX ? `/proc/self/fd/${handle.fd}` : location;
        const names = await fs.readdir(base).catch(() => null);
        if (!names) complete = false;
        for (const name of names ?? []) await walk(path.join(base, name), depth + 1);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }
  await walk(absolute, 0);
  return { bytes, complete };
}

async function moveToTrash(parent: AnchoredDirectory, name: string, relative: string, trash: TrashDirectories) {
  const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const stat = await fs.lstat(inside(parent, name));
  const type = entryType(stat);
  const info: TrashInfo = {
    name,
    originalPath: relative,
    type,
    size: type === "directory" ? 0 : stat.size,
    sizeComplete: type !== "directory",
    deletedAt: new Date().toISOString(),
  };
  // Write the record first so a trashed item is never left without its original location.
  const infoPath = path.join(trash.info, `${id}.json`);
  await fs.writeFile(infoPath, JSON.stringify(info), { flag: "wx", mode: 0o600 });
  try {
    await withOpen(openTrashFolder(trash.items), (items) => moveEntry(parent, name, items, id));
  } catch (error) {
    await fs.rm(infoPath, { force: true });
    throw error;
  }
  if (type === "directory") {
    // Measured once in the trash; measureTree walks through handles, as the folder may still change.
    const measured = await measureTree(path.join(trash.items, id));
    await fs.writeFile(infoPath, JSON.stringify({ ...info, size: measured.bytes, sizeComplete: measured.complete }), { mode: 0o600 }).catch(() => undefined);
  }
  return id;
}

function trashItemPath(trash: TrashDirectories, id: string) {
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[/\\\0]/.test(id) || Buffer.byteLength(id, "utf8") > 255) {
    throw new AppError("Trash item is invalid", 400, "INVALID_TRASH_ITEM");
  }
  return path.join(trash.items, id);
}

async function existingTrashItem(trash: TrashDirectories | null, id: string) {
  if (!trash) throw new AppError("That item is no longer in the trash", 404, "NOT_FOUND");
  const absolute = trashItemPath(trash, id);
  try {
    await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("That item is no longer in the trash", 404, "NOT_FOUND");
    throw error;
  }
  return absolute;
}

// Returns null when an item has no usable record (trashed before records existed, or corrupt).
// Other read failures are thrown so a restore never falls back to the wrong location.
async function readTrashInfo(trash: TrashDirectories, id: string): Promise<TrashInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(trash.info, `${id}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseTrashInfo(raw);
}

function parseTrashInfo(raw: string): TrashInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TrashInfo>;
    if (typeof parsed.originalPath !== "string" || !parsed.originalPath || typeof parsed.deletedAt !== "string") return null;
    const originalPath = normalizeRelative(parsed.originalPath);
    if (!originalPath) return null;
    return {
      name: path.posix.basename(originalPath),
      originalPath,
      type: parsed.type === "directory" || parsed.type === "symlink" ? parsed.type : "file",
      size: Number.isFinite(parsed.size) ? Number(parsed.size) : 0,
      sizeComplete: parsed.sizeComplete !== false,
      deletedAt: parsed.deletedAt,
    };
  } catch {
    return null;
  }
}

async function describeTrashItem(trash: TrashDirectories, id: string): Promise<TrashItem | null> {
  const absolute = path.join(trash.items, id);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return null;
  const info = await readTrashInfo(trash, id);
  const legacy = info ? null : LEGACY_TRASH_ID.exec(id);
  const type = info?.type ?? entryType(stat);
  const name = info?.name ?? legacy?.[1] ?? id;
  let measured = info ? { bytes: info.size, complete: info.sizeComplete } : type === "directory" ? legacyTrashSizes.get(id) : { bytes: stat.size, complete: true };
  if (!measured) {
    // Legacy folders have no recorded size; measure once rather than on every listing.
    measured = await measureTree(absolute);
    legacyTrashSizes.set(id, measured);
  }
  return {
    id,
    name,
    originalPath: info?.originalPath ?? null,
    deletedAt: info?.deletedAt ?? (legacy ? new Date(Number(legacy[2])).toISOString() : stat.ctime.toISOString()),
    type,
    mime: type === "file" ? getMime(name) : "inode/directory",
    size: measured.bytes,
    sizeComplete: measured.complete,
  };
}

export async function listTrash(): Promise<TrashListing> {
  const trash = await trashDirectories();
  if (!trash) return { enabled: config.trashEnabled, items: [], totalBytes: 0 };
  const ids = await fs.readdir(trash.items);
  const items: TrashItem[] = [];
  // Read records in batches so a very large trash cannot exhaust file descriptors.
  for (let offset = 0; offset < ids.length; offset += 64) {
    const described = await Promise.all(ids.slice(offset, offset + 64).map((id) => describeTrashItem(trash, id)));
    items.push(...described.filter((item): item is TrashItem => item !== null && trashItemVisible(item.originalPath)));
  }
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.name.localeCompare(b.name));
  return { enabled: config.trashEnabled, items, totalBytes: items.reduce((total, item) => total + item.size, 0) };
}

// Opens relativePath as a folder, recreating any missing folders on the way, each made and opened
// through the one above it.
async function openDirectoryPath(relativePath: string) {
  const parts = relativePath ? relativePath.split("/") : [];
  let existing = parts.length;
  while (existing > 0) {
    try {
      await safeResolve(parts.slice(0, existing).join("/"));
      break;
    } catch (error) {
      const missing = error instanceof AppError ? error.code === "NOT_FOUND" : (error as NodeJS.ErrnoException).code === "ENOTDIR";
      if (!missing) throw error;
      existing -= 1;
    }
  }
  const base = parts.slice(0, existing).join("/");
  let directory = await openDirectory(base).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_A_DIRECTORY") {
      throw new AppError(`/${base} is no longer a folder, so the item cannot be restored there`, 409, "RESTORE_CONFLICT");
    }
    throw error;
  });
  try {
    for (let index = existing; index < parts.length; index += 1) {
      const folder = parts.slice(0, index + 1).join("/");
      await safeResolve(folder, { mustExist: false });
      try {
        await fs.mkdir(inside(directory, parts[index]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new AppError(`/${folder} is in the way of the original location, so the item cannot be restored there`, 409, "RESTORE_CONFLICT");
      }
      const child = await openChild(directory, parts[index]);
      await directory.handle.close().catch(() => undefined);
      directory = child;
    }
    return directory;
  } catch (error) {
    await directory.handle.close().catch(() => undefined);
    throw error;
  }
}

// Shortens `stem` (by whole characters) so that it and `suffix` fit the 255-byte name limit.
function fitName(stem: string, suffix: string) {
  const characters = [...stem];
  while (characters.length && Buffer.byteLength(characters.join("") + suffix, "utf8") > 255) characters.pop();
  return characters.join("") + suffix;
}

// Picks name, then "name (label).ext", "name (label 2).ext", ... in the folder, whichever is free.
// With `labelled`, the plain name is skipped.
async function availableName(directory: AnchoredDirectory, name: string, type: EntryType, label: string, labelled = false) {
  if (INTERNAL_NAMES.has(name)) throw new AppError("That name is reserved", 400, "RESERVED_NAME");
  const extension = type === "directory" ? "" : path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = labelled ? 1 : 0; index < 1_000; index += 1) {
    const candidateName = index === 0 ? name : fitName(stem, ` (${label}${index > 1 ? ` ${index}` : ""})${extension}`);
    if (!(await fs.lstat(inside(directory, candidateName)).catch(missingAsNull))) return { name: candidateName, renamed: index > 0 };
  }
  throw new AppError(`Unable to choose an available name for ${name}`, 409, "NAME_CONFLICT");
}

export async function restoreTrashItems(ids: string[]): Promise<TrashRestoreResult[]> {
  if (!ids.length) throw new AppError("Choose at least one item", 400);
  const trash = await trashDirectories();
  const restored: TrashRestoreResult[] = [];
  for (const id of ids) {
    const source = await existingTrashItem(trash, id);
    const info = await readTrashInfo(trash!, id);
    if (!trashItemVisible(info?.originalPath ?? null)) throw new AppError("That item is no longer in the trash", 404, "NOT_FOUND");
    const originalPath = info?.originalPath ?? validateName(LEGACY_TRASH_ID.exec(id)?.[1] ?? id);
    const parentRelative = parentOf(originalPath);
    const type = info?.type ?? entryType(await fs.lstat(source));
    const result = await withOpen(openDirectoryPath(parentRelative), async (directory) => {
      const { name, renamed } = await availableName(directory, path.posix.basename(originalPath), type, "restored");
      await withOpen(openTrashFolder(trash!.items), (items) => moveEntry(items, id, directory, name));
      return { path: childOf(parentRelative, name), renamed };
    });
    await fs.rm(path.join(trash!.info, `${id}.json`), { force: true });
    restored.push({ id, ...result });
  }
  return restored;
}

export async function deleteTrashItems(ids: string[]) {
  if (!ids.length) throw new AppError("Choose at least one item", 400);
  const trash = await trashDirectories();
  for (const id of ids) {
    await existingTrashItem(trash, id);
    if (!trashItemVisible((await readTrashInfo(trash!, id))?.originalPath ?? null)) throw new AppError("That item is no longer in the trash", 404, "NOT_FOUND");
    // A process already inside a trashed folder can still change it, so it is removed through handles.
    await withOpen(openTrashFolder(trash!.items), (items) => removeEntry(items, id));
    await fs.rm(path.join(trash!.info, `${id}.json`), { force: true });
  }
  return { removed: ids.length };
}

// Opens one of FilesDude's trash folders for a whole purge run, refusing it unless it is still the
// real folder at that location and owned by this service.
async function openVerifiedTrashFolder(location: string) {
  const folder = await openTrashFolder(location);
  try {
    const opened = await openedHandlePath(folder.handle, location);
    if (opened !== location || !privateToService(folder.stat)) {
      throw new AppError("FilesDude's trash folder is not a regular folder inside the root", 500, "TRASH_UNSAFE");
    }
    return folder;
  } catch (error) {
    await folder.handle.close().catch(() => undefined);
    throw error;
  }
}

// An item's record, read through the open records folder without following links; null if it is
// missing or unreadable.
async function readTrashRecord(info: AnchoredDirectory, id: string) {
  const handle = await fs.open(inside(info, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    return stat.isFile() && stat.size <= 64 * 1024 ? parseTrashInfo(await handle.readFile("utf8")) : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// When an item went to the trash, from its record or the timestamp in a legacy name. Anything else
// has no known deletion time.
function trashDeletedAt(record: TrashInfo | null, id: string) {
  if (record) return Date.parse(record.deletedAt);
  const legacy = LEGACY_TRASH_ID.exec(id);
  return legacy ? Number(legacy[2]) : Number.NaN;
}

export type TrashPurgeResult = { removed: Array<{ id: string; originalPath: string | null }>; failed: number };

/**
 * Permanently removes trash items deleted longer ago than `retentionDays()` allows. The setting is
 * read again before each removal, so changing it stops a run in progress. The filesystem lock is
 * taken one item at a time, so other work isn't held up, and an item that can't be removed is
 * logged and skipped rather than stopping the run. Items with no known deletion time are kept.
 * Both trash folders are opened once and verified, and everything goes through those handles.
 */
export async function purgeExpiredTrash(retentionDays: () => Promise<number | null>, now = () => Date.now()): Promise<TrashPurgeResult> {
  const result: TrashPurgeResult = { removed: [], failed: 0 };
  const trash = await trashDirectories();
  if (!trash) return result;
  const items = await openVerifiedTrashFolder(trash.items);
  try {
    const info = await openVerifiedTrashFolder(trash.info);
    try {
      for (const id of await fs.readdir(items.base)) {
        const record = await readTrashRecord(info, id);
        const deletedAt = trashDeletedAt(record, id);
        if (!Number.isFinite(deletedAt)) continue;
        try {
          const outcome = await withFilesystemLock(async () => {
            const days = await retentionDays();
            if (!days) return "stop";
            if (deletedAt >= now() - days * 86_400_000) return "keep";
            await removeEntry(items, id);
            await fs.unlink(inside(info, `${id}.json`)).catch(() => undefined);
            legacyTrashSizes.delete(id);
            result.removed.push({ id, originalPath: record?.originalPath ?? null });
            return "removed";
          });
          if (outcome === "stop") break;
        } catch (error) {
          result.failed += 1;
          console.error(`Could not purge trash item ${id}`, error);
        }
      }
    } finally {
      await info.handle.close().catch(() => undefined);
    }
  } finally {
    await items.handle.close().catch(() => undefined);
  }
  return result;
}

export type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number };

// Opens the folder holding `relativePath` only if it is its real location (no link anywhere on
// the way), and checks the item there is still exactly the file described by `expected`.
async function withUnchangedFile<T>(relativePath: string, expected: FileIdentity, run: (parent: AnchoredDirectory, name: string, relative: string) => Promise<T>): Promise<T | null> {
  const root = await ensureRoot();
  return withParent(relativePath, async (parent, name, relative) => {
    const parentRelative = parentOf(relative);
    if (parent.real !== (parentRelative ? path.join(root, ...parentRelative.split("/")) : root)) return null;
    const stat = await fs.lstat(inside(parent, name)).catch(missingAsNull);
    if (!stat?.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs) return null;
    return run(parent, name, relative);
  }).catch((error: unknown) => {
    if (error instanceof AppError && ["NOT_FOUND", "NOT_A_DIRECTORY", "PATH_CHANGED"].includes(error.code ?? "")) return null;
    throw error;
  });
}

/** Whether `relativePath` is still exactly the file described, at its real location. */
export async function isUnchangedFile(relativePath: string, expected: FileIdentity) {
  return (await withUnchangedFile(relativePath, expected, async () => true)) === true;
}

/**
 * Moves a file to the protected trash only if it is still exactly the file described (same
 * identity, size, and modification time, at its real location). Returns its trash id, or null if
 * it changed. Call with the filesystem lock held.
 */
export async function trashIfUnchanged(relativePath: string, expected: FileIdentity) {
  if (!config.trashEnabled) throw new AppError("Protected trash is turned off", 409, "TRASH_DISABLED");
  const trash = await trashDirectories(true);
  return withUnchangedFile(relativePath, expected, (parent, name, relative) => moveToTrash(parent, name, relative, trash));
}

export type LinkOutcome =
  | { linked: true; trashId: string }
  | { linked: false; reason: "changed" | "different-owner" | "permissions" | "other-filesystem" | "failed"; trashId?: undefined }
  | { linked: false; reason: "taken"; trashId: string };

// Linking shares one inode's access with both paths. Files writable by group or others (which also
// covers ACL entries granting write, as the ACL mask shows in the group bits) or executable (file
// capabilities, which can't be compared here) are left alone.
const linkableMode = (mode: number) => (mode & 0o022) === 0 && (mode & 0o111) === 0;

/**
 * Replaces a duplicate file with a hard link to an identical kept file, keeping the duplicate's
 * path working while the two share one copy of the data. Both must still be exactly as described,
 * at their real locations, with the same owner, group, and permissions (a hard link shares them).
 * The link is made first under a temporary name, the duplicate is moved to the protected trash (so
 * this can be undone), and the link then takes its name without replacing anything that appeared
 * meanwhile. Call with the filesystem lock held.
 */
export async function replaceWithLink(copyPath: string, copy: FileIdentity, targetPath: string, target: FileIdentity): Promise<LinkOutcome> {
  if (!config.trashEnabled) throw new AppError("Protected trash is turned off", 409, "TRASH_DISABLED");
  if (copy.dev !== target.dev) return { linked: false, reason: "other-filesystem" };
  const trash = await trashDirectories(true);
  const outcome = await withUnchangedFile(targetPath, target, async (targetParent, targetName) => withUnchangedFile(copyPath, copy, async (parent, name, relative): Promise<LinkOutcome> => {
    const [kept, duplicate] = await Promise.all([fs.lstat(inside(targetParent, targetName)), fs.lstat(inside(parent, name))]);
    if (kept.uid !== duplicate.uid || kept.gid !== duplicate.gid || (kept.mode & 0o7777) !== (duplicate.mode & 0o7777)) return { linked: false, reason: "different-owner" };
    if (!linkableMode(duplicate.mode)) return { linked: false, reason: "permissions" };
    const temporary = `.filedude-link-${crypto.randomUUID()}`;
    try {
      await fs.link(inside(targetParent, targetName), inside(parent, temporary));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") return { linked: false, reason: "other-filesystem" };
      throw error;
    }
    try {
      // The kept file is checked again through the link actually made: if its name was swapped
      // for another file since the checks above, nothing is replaced.
      const made = await fs.lstat(inside(parent, temporary));
      if (!made.isFile() || made.dev !== target.dev || made.ino !== target.ino || made.uid !== duplicate.uid || made.gid !== duplicate.gid || (made.mode & 0o7777) !== (duplicate.mode & 0o7777)) {
        return { linked: false, reason: "changed" };
      }
      const trashId = await moveToTrash(parent, name, relative, trash);
      try {
        // A link can't replace a name, so anything that took the name meanwhile is kept.
        await fs.link(inside(parent, temporary), inside(parent, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { linked: false, reason: "taken", trashId };
        // Anything else: the original goes back where it was, so the path isn't left missing.
        console.error("Could not finish replacing a duplicate with a hard link", error);
        await restoreTrashItems([trashId]).catch((restoreError: unknown) => console.error("Could not put a duplicate back from the trash", restoreError));
        return { linked: false, reason: "failed" };
      }
      return { linked: true, trashId };
    } finally {
      await fs.unlink(inside(parent, temporary)).catch(() => undefined);
    }
  }));
  return outcome ?? { linked: false, reason: "changed" };
}

export async function emptyTrash() {
  const trash = await trashDirectories();
  if (!trash) return { removed: 0 };
  const ids = await fs.readdir(trash.items);
  await withOpen(openTrashFolder(trash.items), async (items) => {
    for (const id of ids) await removeEntry(items, id);
  });
  legacyTrashSizes.clear();
  // Also clears records whose items were removed outside FilesDude.
  for (const name of await fs.readdir(trash.info)) await fs.rm(path.join(trash.info, name), { force: true });
  return { removed: ids.length };
}

// Thrown when a multi-item transfer fails part-way, so callers can account for what already moved.
export class PartialTransferError extends AppError {
  constructor(cause: unknown, public completed: TransferResult[], move: boolean) {
    const known = cause instanceof AppError;
    if (!known) console.error(cause);
    super(
      `${known ? cause.message : "An item could not be transferred"}. ${completed.length} ${completed.length === 1 ? "item was" : "items were"} ${move ? "moved" : "copied"} before this.`,
      known ? cause.status : 500,
      known ? cause.code : "TRANSFER_FAILED",
    );
  }
}

export type TransferOptions = {
  report?: (progress: JobProgress) => void;
  signal?: AbortSignal;
  /**
   * Called for each moved item as soon as it is in place, while the filesystem lock is held. For a
   * move between filesystems, `copies` maps each original that was copied unchanged (by device and
   * inode) to its copy; anything not in it stayed where it was.
   */
  moved?: (item: TransferResult, copies?: CopiedItems) => Promise<void>;
};

// The total size of what a copy will write, for progress; undefined when it can't be measured fully.
async function measureSources(paths: string[], signal?: AbortSignal) {
  let total = 0;
  for (const sourcePath of paths) {
    throwIfCancelled(signal);
    const measured = await withParent(sourcePath, (parent, name) => measureTree(inside(parent, name), signal)).catch(() => null);
    if (!measured?.complete) return undefined;
    total += measured.bytes;
  }
  return total;
}

/**
 * Copies or moves items into a folder. It takes the filesystem lock itself, and only for the quick
 * steps (checks, renames, and choosing names): a copy is written under a hidden temporary name
 * without the lock, so a large copy doesn't hold up everything else, and gets its final name under
 * the lock once complete. A copy that fails or is cancelled part-way is removed. Copies that would
 * collide get a free "name (copy).ext" name; moves never rename and fail on a conflict.
 */
export async function copyOrMove(requested: string[], destinationPath: string, move: boolean, { report, signal, moved }: TransferOptions = {}): Promise<TransferResult[]> {
  const paths = [...new Set(requested.map(cleanRelative))];
  const destinationRelative = cleanRelative(destinationPath);
  const destination = await withFilesystemLock(() => openDirectory(destinationRelative)).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_A_DIRECTORY") throw new AppError("Destination is not a folder", 400);
    throw error;
  });
  try {
    const progress: JobProgress = move
      ? { done: 0, total: paths.length, unit: "entries" }
      : { done: 0, total: await measureSources(paths, signal), unit: "bytes" };
    report?.({ ...progress });
    const copied = (bytes: number) => {
      progress.done += bytes;
      report?.({ ...progress });
    };
    const results: TransferResult[] = [];
    for (const sourcePath of paths) {
      try {
        throwIfCancelled(signal);
        results.push(await transferOne(sourcePath, destination, destinationRelative, move, { made: new Set(), signal, copied: move ? undefined : copied, moved }));
        if (move) {
          progress.done += 1;
          report?.({ ...progress });
        }
      } catch (error) {
        if (results.length) throw new PartialTransferError(error, results, move);
        throw error;
      }
    }
    return results;
  } finally {
    await destination.handle.close().catch(() => undefined);
  }
}

type LockControl = { unlock: () => void; relock: () => Promise<void> };

/**
 * Copies `name` from `from` into `destination`, called with the filesystem lock held. The copy is
 * written under a visible "name (copying)" placeholder, chosen and created under the lock, and the
 * lock is let go as soon as the placeholder exists (unless `holdLock`). Once complete, the lock is
 * taken again and the copy is renamed to the name `chooseName` picks, but only if it is still the
 * item this copy created. A failed or cancelled copy is removed.
 */
async function copyThroughPlaceholder(
  from: AnchoredDirectory,
  name: string,
  destination: AnchoredDirectory,
  context: CopyContext,
  lock: LockControl,
  { holdLock, chooseName }: { holdLock: boolean; chooseName: (type: EntryType) => Promise<{ name: string; renamed: boolean }> },
) {
  const type = entryType(await fs.lstat(inside(from, name)));
  const { name: temporary } = await availableName(destination, name, type, "copying", true);
  // The placeholder is journaled as soon as it exists, so a restart part-way through the copy
  // doesn't leave it behind (see recoverInterruptedCopies).
  const journalId = crypto.randomUUID();
  let journaled = false;
  context.created = async () => {
    // The journal only helps clean up after a restart; a copy goes ahead without it.
    await recordCopy({ id: journalId, directory: destination.real, name: temporary, identity: context.top!, birth: context.topBirth, startedAt: new Date().toISOString() })
      .then(() => { journaled = true; }, (error: unknown) => console.error("Could not record a copy in the journal", error));
    if (!holdLock) lock.unlock();
  };
  // Before placing, a failure to forget stops the copy, so no entry can outlive its placeholder
  // and later match the finished copy; when cleaning up, it is only logged.
  const forget = async (strict = false) => {
    if (!journaled) return;
    journaled = false;
    await forgetCopies([journalId]).catch((error: unknown) => {
      if (strict) {
        journaled = true;
        throw error;
      }
      console.error("Could not update the copy journal", error);
    });
  };
  try {
    await copyEntry(from, name, destination, temporary, context);
    await lock.relock();
    throwIfCancelled(context.signal);
    const written = await fs.lstat(inside(destination, temporary)).catch(missingAsNull);
    if (!written || identityOf(written) !== context.top) throw new AppError("The copy changed while it was being written", 409, "PATH_CHANGED");
    const chosen = await chooseName(type);
    // Forgotten before placing, so a stale entry can never point at the finished copy; a crash in
    // between leaves a visible placeholder rather than risking the copy.
    await forget(true);
    await placeEntry(destination, temporary, destination, chosen.name);
    return chosen;
  } catch (error) {
    await lock.relock();
    await removeCreated(destination, temporary, context.top).catch(() => undefined);
    await forget();
    throw error;
  }
}

async function transferOne(sourcePath: string, destination: AnchoredDirectory, destinationRelative: string, move: boolean, context: CopyContext): Promise<TransferResult> {
  const sourceRelative = cleanRelative(sourcePath);
  if (move) assertNotHome(sourceRelative);
  const invalid = new AppError(`You can't ${move ? "move" : "copy"} a folder into itself or one of its own subfolders`, 400, "INVALID_DESTINATION");
  if (!sourceRelative) throw invalid;
  let release: (() => void) | null = await acquireFilesystemLock();
  const unlock = () => {
    release?.();
    release = null;
  };
  const relock = async () => {
    if (!release) release = await acquireFilesystemLock();
  };
  try {
    return await withParent(sourceRelative, async (parent, name, relative) => {
      // Compared by real location, since either path may run through symlinks.
      const sourceReal = path.join(parent.real, name);
      if (destination.real === sourceReal || destination.real.startsWith(`${sourceReal}${path.sep}`)) throw invalid;
      if (move && parent.real === destination.real) throw new AppError("The item is already in that folder", 409, "SAME_DESTINATION");
      const result = (targetName: string, renamed: boolean) => ({ source: relative, path: childOf(destinationRelative, targetName), renamed });
      // Favourites and share links following a moved item are bookkeeping: if updating them fails,
      // the move itself still stands.
      const placed = async (item: TransferResult) => {
        await context.moved?.(item, context.copies).catch((error: unknown) => console.error("Could not update links for a moved item", error));
        return item;
      };
      if (move) {
        try {
          await placeEntry(parent, name, destination, name);
          return await placed(result(name, false));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        }
      }
      // A move between filesystems (rare: the root is normally one filesystem) keeps the lock
      // throughout, so nothing else in FilesDude changes the original meanwhile, and removes only
      // what it copied unchanged; anything other processes add or change stays where it was.
      if (move) Object.assign(context, { sources: new Set(), copies: new Map() });
      const { name: targetName, renamed } = await copyThroughPlaceholder(parent, name, destination, context, { unlock, relock }, {
        holdLock: move,
        chooseName: (type) => (move ? Promise.resolve({ name, renamed: false }) : availableName(destination, name, type, "copy")),
      });
      if (!move) return result(targetName, renamed);
      // The item is in place, so the move stands even if removing the original stops part-way;
      // whatever is left (changed or added while it was copied) is reported, not lost.
      const removed = await removeCopied(parent, name, context.sources!).catch((error: unknown) => {
        console.error("Could not remove all of a moved original", error);
        return false;
      });
      return placed({ ...result(name, false), ...(removed ? {} : { leftBehind: true }) });
    });
  } finally {
    unlock();
  }
}

/**
 * Copies an item out of a ZFS snapshot back into the live tree, into `destinationRelative` (which
 * is recreated if missing, and confined like any other path). The item keeps its name if that is
 * free, otherwise it becomes "name (label).ext"; nothing is ever replaced. `snapshotFolder` is the
 * real path of the folder holding the item inside the snapshot (see snapshotItem).
 */
export async function restoreFromSnapshot(snapshotFolder: string, name: string, destinationRelative: string, label: string, { report, signal }: TransferOptions = {}): Promise<TransferResult> {
  const destinationPath = cleanRelative(destinationRelative);
  return withOpen(openSnapshotFolder(snapshotFolder), async (from) => {
    const measured = await measureTree(inside(from, name), signal);
    const progress: JobProgress = { done: 0, total: measured.complete ? measured.bytes : undefined, unit: "bytes" };
    report?.({ ...progress });
    const context: CopyContext = {
      made: new Set(),
      signal,
      sourceIsSnapshot: true,
      copied: (bytes) => {
        progress.done += bytes;
        report?.({ ...progress });
      },
    };
    let release: (() => void) | null = await acquireFilesystemLock();
    const unlock = () => {
      release?.();
      release = null;
    };
    try {
      return await withOpen(openDirectoryPath(destinationPath), async (destination) => {
        const chosen = await copyThroughPlaceholder(from, name, destination, context, {
          unlock,
          relock: async () => { if (!release) release = await acquireFilesystemLock(); },
        }, { holdLock: false, chooseName: (type) => availableName(destination, name, type, label) });
        return { source: name, path: childOf(destinationPath, chosen.name), renamed: chosen.renamed };
      });
    } finally {
      unlock();
    }
  });
}

/**
 * Removes copy placeholders a restart left behind. It runs once, started by the first use of the
 * filesystem lock after the service starts, so it shares that lock (and the journal's queue) with
 * every request, taking the lock one placeholder at a time. A placeholder is removed only if its
 * folder still has the recorded real location and the item there is still exactly as this service
 * created it: the same identity and creation time, owned by the service, and still with the
 * permissions a copy starts with (a folder 0700, a file 0600). Anything else is left alone.
 */
export async function recoverInterruptedCopies() {
  await ensureRoot();
  const entries = await readCopyJournal();
  for (const entry of entries) {
    try {
      await withFilesystemLock(() => withOpen(openAnchored(entry.directory, { follow: true, checkReserved: true }), async (directory) => {
        if (directory.real !== entry.directory) return;
        const stat = await fs.lstat(inside(directory, entry.name), { bigint: true }).catch(missingAsNull);
        if (!stat || `${stat.dev}:${stat.ino}` !== entry.identity) return;
        if (entry.birth !== undefined && String(stat.birthtimeNs) !== entry.birth) return;
        // Its own, or (from before FilesDude ran as its own account) root's.
        if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()) && stat.uid !== BigInt(0)) return;
        const mode = Number(stat.mode & BigInt(0o7777));
        if (stat.isDirectory() ? mode !== 0o700 : stat.isFile() ? mode !== 0o600 : !stat.isSymbolicLink()) return;
        await removeCreated(directory, entry.name, entry.identity);
      }));
    } catch (error) {
      if (!(error instanceof AppError && error.code === "NOT_FOUND")) console.error("Could not clean up an interrupted copy", error);
    }
  }
  if (entries.length) await forgetCopies(entries.map((entry) => entry.id));
}

let recoveryStarted = false;

function startRecovery() {
  if (recoveryStarted) return;
  recoveryStarted = true;
  // Outside the triggering request's account, which may be confined to a folder.
  void runUnscoped(() => recoverInterruptedCopies()).catch((error: unknown) => console.error("Could not clean up interrupted copies", error));
}

export async function changeMode(paths: string[], mode: string) {
  if (!/^[0-7]{3,4}$/.test(mode)) throw new AppError("Permissions must be an octal value such as 755", 400);
  // Set-user-id and set-group-id bits are never set from here (copies drop them too); the sticky bit is.
  const bits = Number.parseInt(mode, 8) & 0o1777;
  for (const relativePath of paths) await fs.chmod(await safeResolve(relativePath), bits);
}

export async function changeOwner(paths: string[], uid: number, gid: number) {
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    throw new AppError("Owner and group must be numeric ids", 400);
  }
  for (const relativePath of paths) await fs.chown(await safeResolve(relativePath), uid, gid);
}

export async function writeTextFile(relativePath: string, content: string) {
  const maxBytes = 2 * 1024 * 1024;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new AppError("Text editing is limited to 2 MB per file", 413, "EDIT_TOO_LARGE");
  }
  const { absolute, handle, stat } = await openVerifiedFile(relativePath, "write");
  try {
    if (!stat.isFile()) throw new AppError("Only files can be edited", 400, "NOT_A_FILE");
    const mime = getMime(absolute);
    const editable = mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || mime.includes("typescript");
    if (!editable) throw new AppError("This file type cannot be edited as text", 415, "NOT_EDITABLE");
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  return details(relativePath);
}

const stemOf = (name: string) => {
  const extension = path.extname(name);
  return extension ? name.slice(0, -extension.length) : name;
};

/** A bulk rename's rule, checked so no part of it can make huge names or take long. */
function checkRule(rule: unknown): BulkRenameRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new AppError("Bulk rename rules are required", 400, "INVALID_REQUEST");
  const value = rule as Record<string, unknown>;
  const text = (key: string, max: number) => {
    if (value[key] === undefined) return;
    if (typeof value[key] !== "string" || (value[key] as string).length > max) throw new AppError("A bulk rename rule is too long", 400, "INVALID_RULE");
  };
  text("find", 256);
  text("replace", 255);
  text("prefix", 255);
  text("suffix", 255);
  for (const flag of ["regex", "caseSensitive", "numbering"]) if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw new AppError("A bulk rename rule is invalid", 400, "INVALID_RULE");
  if (value.pad !== undefined && (!Number.isInteger(value.pad) || (value.pad as number) < 0 || (value.pad as number) > 10)) throw new AppError("Numbers can be padded to at most 10 digits", 400, "INVALID_RULE");
  if (value.start !== undefined && (!Number.isInteger(value.start) || (value.start as number) < 0 || (value.start as number) > 1e9)) throw new AppError("Numbering must start between 0 and 1,000,000,000", 400, "INVALID_RULE");
  return value as BulkRenameRule;
}

/** With a regular expression, every name's new stem, worked out away from the main thread. */
async function patternStems(names: string[], rule: BulkRenameRule) {
  if (!rule.find || !rule.regex) return null;
  return replaceWithPattern(names.map(stemOf), rule.find, rule.caseSensitive ? "g" : "gi", rule.replace || "");
}

function renamedName(original: string, index: number, rule: BulkRenameRule, patternStem?: string) {
  const extension = path.extname(original);
  const stem = stemOf(original);
  let next = stem;
  if (patternStem !== undefined) next = patternStem;
  else if (rule.find) {
    if (rule.caseSensitive) {
      next = next.split(rule.find).join(rule.replace || "");
    } else {
      next = next.replace(new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), rule.replace || "");
    }
  }
  if (rule.numbering) {
    const number = String((rule.start ?? 1) + index).padStart(rule.pad ?? 2, "0");
    next = `${next}-${number}`;
  }
  return validateName(`${rule.prefix || ""}${next}${rule.suffix || ""}${extension}`);
}

export async function previewBulkRename(paths: string[], rawRule: unknown): Promise<RenamePreview[]> {
  const rule = checkRule(rawRule);
  const relatives = paths.map(cleanRelative);
  const stems = await patternStems(relatives.map((relative) => path.posix.basename(relative)), rule);
  const previews: RenamePreview[] = [];
  const destinations = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const relative = relatives[index];
    await safeResolve(relative);
    const from = path.posix.basename(relative);
    const to = renamedName(from, index, rule, stems?.[index]);
    let error: string | undefined;
    // Two items end up with the same name in the same real folder (even through a link to it).
    const existing = await withParent(relative, async (parent) => {
      const destination = `${parent.real}\u0000${to}`;
      if (destinations.has(destination)) error = "Duplicate destination";
      destinations.add(destination);
      return to === from ? null : fs.lstat(inside(parent, to)).catch(missingAsNull);
    });
    if (existing) error = "Name already exists";
    previews.push({ source: paths[index], from, to, changed: from !== to, error });
  }
  return previews;
}

export async function applyBulkRename(paths: string[], rule: unknown) {
  for (const item of paths) assertNotHome(normalizeRelative(item));
  const previews = await previewBulkRename(paths, rule);
  if (previews.some((item) => item.error)) throw new AppError("Resolve bulk rename conflicts before applying", 409, "RENAME_CONFLICT");

  // One open handle per parent folder, kept until every rename has finished or been rolled back.
  const parents = new Map<string, AnchoredDirectory>();
  const staged: Array<{ original: string; temporary: string; destination: string }> = [];
  try {
    for (const preview of previews.filter((item) => item.changed)) {
      const relative = cleanRelative(preview.source);
      await safeResolve(relative, { followSymlink: false });
      const parentRelative = parentOf(relative);
      let parent = parents.get(parentRelative);
      if (!parent) {
        parent = await openDirectory(parentRelative);
        parents.set(parentRelative, parent);
      }
      const name = path.posix.basename(relative);
      const temporary = inside(parent, `.filedude-rename-${crypto.randomUUID()}`);
      await fs.rename(inside(parent, name), temporary);
      staged.push({ original: inside(parent, name), temporary, destination: inside(parent, preview.to) });
    }
    // Never over something: a name that's been taken since stops (and undoes) the whole rename.
    for (const item of staged) {
      if (await fs.lstat(item.destination).catch(missingAsNull)) throw new AppError("Something with one of the new names appeared while renaming", 409, "RENAME_CONFLICT");
      await fs.rename(item.temporary, item.destination);
    }
  } catch (error) {
    for (const item of [...staged].reverse()) {
      try {
        await fs.lstat(item.temporary);
        await fs.rename(item.temporary, item.original);
      } catch {
        try {
          await fs.lstat(item.destination);
          await fs.rename(item.destination, item.original);
        } catch {
          // Best-effort recovery; the audit log records the original operation.
        }
      }
    }
    throw error;
  } finally {
    for (const parent of parents.values()) await parent.handle.close().catch(() => undefined);
  }
  return previews;
}

export async function details(relativePath: string) {
  const relative = cleanRelative(relativePath);
  // The root and an account's home folder have no parent the account may open; read them directly.
  if (!relative || relative === scopeRoot()) {
    return withOpen(openDirectory(relative), (directory) => toEntry(directory.base, relative, path.basename(directory.real), directory.stat));
  }
  return withParent(relative, (parent, name) => toEntry(inside(parent, name), relative, name));
}

type LargestCandidate = { absolute: string; size: number };
type LargestFilesIndex = {
  candidates: LargestCandidate[];
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  durationMs: number;
  generatedAt: string;
};
type LargestScanProgress = {
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  startedAt: number;
};

// A whole-tree scan can take far longer than a single HTTP request should stay open
// (large trees have exceeded gateway/proxy timeouts). Instead of awaiting it to
// completion, each call waits up to this long and, if the scan is still running,
// reports live progress so the caller can poll again against the same in-flight scan.
const SCAN_POLL_TIMEOUT_MS = 8_000;

async function scanLargestFiles(progress: LargestScanProgress): Promise<LargestFilesIndex> {
  const root = await ensureRoot();
  const directoryQueue = [root];
  const candidates: LargestCandidate[] = [];

  while (directoryQueue.length) {
    const batch = directoryQueue.splice(0, 4);
    const discovered = await Promise.all(batch.map(async (directory) => {
      progress.scannedDirectories += 1;
      let entries: Dirent[];
      try {
        const directoryStat = await fs.lstat(directory);
        const realDirectory = await fs.realpath(directory);
        if (!directoryStat.isDirectory() || !insideRoot(realDirectory)) throw new Error("Directory is no longer safe to scan");
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        progress.skippedEntries += 1;
        return [] as string[];
      }

      const directories: string[] = [];
      for (let offset = 0; offset < entries.length; offset += 64) {
        const chunk = entries.slice(offset, offset + 64).filter((entry) => !INTERNAL_NAMES.has(entry.name) && !entry.isSymbolicLink());
        const stats = await Promise.allSettled(chunk.map(async (entry) => ({
          entry,
          absolute: path.join(directory, entry.name),
          stat: await fs.lstat(path.join(directory, entry.name)),
        })));
        for (const item of stats) {
          if (item.status !== "fulfilled") {
            progress.skippedEntries += 1;
            continue;
          }
          if (item.value.stat.isDirectory()) directories.push(item.value.absolute);
          else if (item.value.stat.isFile()) {
            progress.scannedFiles += 1;
            candidates.push({ absolute: item.value.absolute, size: item.value.stat.size });
          }
        }
      }
      return directories;
    }));
    directoryQueue.push(...discovered.flat());
  }

  candidates.sort((a, b) => b.size - a.size || a.absolute.localeCompare(b.absolute));
  return {
    candidates,
    scannedFiles: progress.scannedFiles,
    scannedDirectories: progress.scannedDirectories,
    skippedEntries: progress.skippedEntries,
    durationMs: Date.now() - progress.startedAt,
    generatedAt: new Date().toISOString(),
  };
}

function scanningResult(progress: LargestScanProgress): LargestFilesScanning {
  return {
    status: "scanning",
    progress: {
      scannedFiles: progress.scannedFiles,
      scannedDirectories: progress.scannedDirectories,
      skippedEntries: progress.skippedEntries,
      elapsedMs: Date.now() - progress.startedAt,
    },
  };
}

async function pageLargestFilesIndex(index: LargestFilesIndex, { minBytes, offset, limit, cached }: { minBytes: number; offset: number; limit: number; cached: boolean }): Promise<LargestFilesResult> {
  const matching = minBytes > 0 ? index.candidates.filter((candidate) => candidate.size >= minBytes) : index.candidates;
  const page = matching.slice(offset, offset + limit);
  const entries: FileEntry[] = [];
  let pageSkipped = 0;
  for (let start = 0; start < page.length; start += 64) {
    const converted = await Promise.allSettled(page.slice(start, start + 64).map((candidate) => toEntry(candidate.absolute, relativeFromAbsolute(candidate.absolute), path.basename(candidate.absolute))));
    entries.push(...converted.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
    pageSkipped += converted.filter((item) => item.status === "rejected").length;
  }
  const nextOffset = Math.min(matching.length, offset + page.length);
  return {
    status: "ready",
    entries,
    totalMatching: matching.length,
    matchingBytes: matching.reduce((total, candidate) => total + candidate.size, 0),
    offset,
    limit,
    nextOffset,
    hasMore: nextOffset < matching.length,
    scannedFiles: index.scannedFiles,
    scannedDirectories: index.scannedDirectories,
    skippedEntries: index.skippedEntries + pageSkipped,
    durationMs: index.durationMs,
    generatedAt: index.generatedAt,
    cached,
  };
}

export async function largestFiles({ refresh = false, minBytes = 0, offset = 0, limit = 100, pollTimeoutMs = SCAN_POLL_TIMEOUT_MS }: { refresh?: boolean; minBytes?: number; offset?: number; limit?: number; pollTimeoutMs?: number } = {}): Promise<LargestFilesResult> {
  if (!largestFilesScan && !refresh && largestFilesCache && Date.now() - largestFilesCache.at < 5 * 60_000) {
    return pageLargestFilesIndex(largestFilesCache.index, { minBytes, offset, limit, cached: true });
  }

  if (!largestFilesScan) {
    const progress: LargestScanProgress = { scannedFiles: 0, scannedDirectories: 0, skippedEntries: 0, startedAt: Date.now() };
    const promise = scanLargestFiles(progress)
      .then((value) => {
        largestFilesCache = { at: Date.now(), index: value };
        return value;
      })
      .finally(() => { largestFilesScan = null; });
    largestFilesScan = { promise, progress };
  }

  const scan = largestFilesScan;
  const timeout = new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), pollTimeoutMs); });
  const outcome = await Promise.race([scan.promise, timeout]);
  if (outcome === "timeout") return scanningResult(scan.progress);
  return pageLargestFilesIndex(outcome, { minBytes, offset, limit, cached: false });
}
