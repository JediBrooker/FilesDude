import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { AppError } from "./http";
import type { BulkRenameRule, DeleteResult, DiskInfo, EntryType, FileEntry, IdentityOption, LargestFilesResult, LargestFilesScanning, OwnershipPair, RenamePreview, TransferResult, TrashItem, TrashListing, TrashRestoreResult } from "./types";

export const INTERNAL_NAMES = new Set([".filedude"]);
const mimeTypes: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".js": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".css": "text/css", ".html": "text/html", ".log": "text/plain",
  ".xml": "text/xml", ".yml": "text/yaml", ".yaml": "text/yaml", ".sh": "text/x-shellscript",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
};

let identitiesCache: { users: Map<number, string>; groups: Map<number, string>; at: number } | null = null;
let canonicalRoot: string | null = null;
let largestFilesCache: { at: number; index: LargestFilesIndex } | null = null;
let largestFilesScan: { promise: Promise<LargestFilesIndex>; progress: LargestScanProgress } | null = null;
let filesystemQueue: Promise<void> = Promise.resolve();

export async function acquireFilesystemLock() {
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

function insideRoot(candidate: string) {
  const root = canonicalRoot || config.root;
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function ensureRoot() {
  await fs.mkdir(config.root, { recursive: true });
  canonicalRoot = await fs.realpath(config.root);
  return canonicalRoot;
}

export async function safeResolve(input = "", options: { mustExist?: boolean; allowInternal?: boolean; followSymlink?: boolean } = {}) {
  const relative = normalizeRelative(input);
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

export async function openVerifiedFile(relativePath: string, flags: string | number = "r") {
  const absolute = await safeResolve(relativePath);
  const handle = await fs.open(absolute, flags);
  try {
    const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, absolute);
    return { absolute, handle, openedPath, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function relativeFromAbsolute(absolute: string) {
  return path.relative(canonicalRoot || config.root, absolute).split(path.sep).join("/");
}

async function identities() {
  if (identitiesCache && Date.now() - identitiesCache.at < 60_000) return identitiesCache;
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
    canChangeOwnership: typeof process.getuid === "function" && process.getuid() === 0,
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

async function toEntry(absolute: string, name = path.basename(absolute)): Promise<FileEntry> {
  const stat = await fs.lstat(absolute);
  const ids = await identities();
  const type: FileEntry["type"] = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
  let symlinkTarget: string | undefined;
  let symlinkBlocked = false;

  if (type === "symlink") {
    symlinkTarget = await fs.readlink(absolute);
    try {
      const real = await fs.realpath(absolute);
      symlinkBlocked = !insideRoot(real);
    } catch {
      symlinkBlocked = true;
    }
  }

  return {
    name,
    path: relativeFromAbsolute(absolute),
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

export async function listDirectory(relativePath = "", showHidden = false) {
  const absolute = await safeResolve(relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw new AppError("Path is not a folder", 400, "NOT_A_DIRECTORY");

  const names = await fs.readdir(absolute);
  const visible = names.filter((name) => !INTERNAL_NAMES.has(name) && (showHidden || !name.startsWith(".")));
  const entries = await Promise.all(visible.map((name) => toEntry(path.join(absolute, name), name)));
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path: normalizeRelative(relativePath), entries, disk: await diskInfo() };
}

export async function searchFiles(relativePath: string, query: string, showHidden = false) {
  const base = await safeResolve(relativePath);
  const needle = query.toLocaleLowerCase();
  const results: FileEntry[] = [];

  async function walk(directory: string, depth: number) {
    if (depth > 20 || results.length >= 500) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 500) return;
      if (INTERNAL_NAMES.has(entry.name) || (!showHidden && entry.name.startsWith("."))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name.toLocaleLowerCase().includes(needle)) results.push(await toEntry(absolute, entry.name));
      if (entry.isDirectory()) await walk(absolute, depth + 1);
    }
  }

  await walk(base, 0);
  return { path: normalizeRelative(relativePath), entries: results, disk: await diskInfo(), truncated: results.length >= 500 };
}

export function validateName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new AppError("Enter a valid name without slashes", 400, "INVALID_NAME");
  }
  if (INTERNAL_NAMES.has(trimmed)) throw new AppError("That name is reserved", 400, "RESERVED_NAME");
  return trimmed;
}

export async function createEntry(parentPath: string, name: string, type: "file" | "directory") {
  const parent = await safeResolve(parentPath);
  const target = path.join(parent, validateName(name));
  await safeResolve(relativeFromAbsolute(target), { mustExist: false });
  if (type === "directory") await fs.mkdir(target);
  else await fs.writeFile(target, "", { flag: "wx" });
  return toEntry(target);
}

export async function renameEntry(sourcePath: string, newName: string) {
  const source = await safeResolve(sourcePath, { followSymlink: false });
  const target = path.join(path.dirname(source), validateName(newName));
  if (target === source) return toEntry(source);
  await safeResolve(relativeFromAbsolute(target), { mustExist: false });
  try {
    await fs.access(target);
    const [sourceReal, targetReal] = await Promise.all([fs.realpath(source), fs.realpath(target)]);
    if (sourceReal !== targetReal) throw new AppError("An item with that name already exists", 409, "NAME_CONFLICT");
    const temporary = path.join(path.dirname(source), `.filedude-case-${crypto.randomUUID()}`);
    await fs.rename(source, temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.rename(source, target);
    else throw error;
  }
  return toEntry(target);
}

async function renameAcrossDevices(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(source, { recursive: true, force: false });
  }
}

export async function deleteEntries(paths: string[], permanent = false): Promise<DeleteResult> {
  if (!paths.length) throw new AppError("Choose at least one item", 400);
  const root = await ensureRoot();
  const trash = !permanent && config.trashEnabled ? await trashDirectories(true) : null;
  const trashed: DeleteResult["trashed"] = [];

  for (const relativePath of paths) {
    const source = await safeResolve(relativePath, { followSymlink: false });
    if (source === root) throw new AppError("The configured root cannot be deleted", 403);
    if (trash) trashed.push({ path: relativeFromAbsolute(source), id: await moveToTrash(source, trash) });
    else await fs.rm(source, { recursive: true, force: false });
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

async function trashDirectories(create: true): Promise<TrashDirectories>;
async function trashDirectories(create?: boolean): Promise<TrashDirectories | null>;
async function trashDirectories(create = false) {
  const internal = path.join(await ensureRoot(), ".filedude");
  const directories = { items: path.join(internal, "trash"), info: path.join(internal, "trash-info") };
  for (const directory of Object.values(directories)) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if ((await fs.realpath(directory)) !== directory) {
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

export async function measureTree(absolute: string) {
  let bytes = 0;
  let visited = 0;
  let complete = true;
  const stack = [absolute];
  while (stack.length) {
    if (visited >= TRASH_MEASURE_LIMIT) return { bytes, complete: false };
    const current = stack.pop()!;
    visited += 1;
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) {
      complete = false;
    } else if (stat.isFile()) {
      bytes += stat.size;
    } else if (stat.isDirectory()) {
      const names = await fs.readdir(current).catch(() => null);
      if (names) stack.push(...names.map((name) => path.join(current, name)));
      else complete = false;
    }
  }
  return { bytes, complete };
}

async function moveToTrash(source: string, trash: TrashDirectories) {
  const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const stat = await fs.lstat(source);
  const type = entryType(stat);
  const measured = type === "directory" ? await measureTree(source) : { bytes: stat.size, complete: true };
  const info: TrashInfo = {
    name: path.basename(source),
    originalPath: relativeFromAbsolute(source),
    type,
    size: measured.bytes,
    sizeComplete: measured.complete,
    deletedAt: new Date().toISOString(),
  };
  // Write the record first so a trashed item is never left without its original location.
  const infoPath = path.join(trash.info, `${id}.json`);
  await fs.writeFile(infoPath, JSON.stringify(info), { flag: "wx", mode: 0o600 });
  try {
    await renameAcrossDevices(source, path.join(trash.items, id));
  } catch (error) {
    await fs.rm(infoPath, { force: true });
    throw error;
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
    items.push(...described.filter((item): item is TrashItem => item !== null));
  }
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.name.localeCompare(b.name));
  return { enabled: config.trashEnabled, items, totalBytes: items.reduce((total, item) => total + item.size, 0) };
}

// Recreates any missing folders on the way to relativePath and returns it.
async function ensureDirectoryPath(relativePath: string) {
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
  if (!(await fs.stat(await safeResolve(base))).isDirectory()) {
    throw new AppError(`/${base} is no longer a folder, so the item cannot be restored there`, 409, "RESTORE_CONFLICT");
  }
  for (let index = existing + 1; index <= parts.length; index += 1) {
    const folder = parts.slice(0, index).join("/");
    try {
      await fs.mkdir(await safeResolve(folder, { mustExist: false }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new AppError(`/${folder} is in the way of the original location, so the item cannot be restored there`, 409, "RESTORE_CONFLICT");
    }
  }
  return relativePath;
}

// Picks name, then "name (label).ext", "name (label 2).ext", ... in parentRelative, whichever is free.
async function availableTarget(parentRelative: string, name: string, type: EntryType, label: string) {
  const extension = type === "directory" ? "" : path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 0; index < 1_000; index += 1) {
    const candidateName = index === 0 ? name : `${stem} (${label}${index > 1 ? ` ${index}` : ""})${extension}`;
    const target = await safeResolve([parentRelative, candidateName].filter(Boolean).join("/"), { mustExist: false, followSymlink: false });
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target, renamed: index > 0 };
      throw error;
    }
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
    const originalPath = info?.originalPath ?? validateName(LEGACY_TRASH_ID.exec(id)?.[1] ?? id);
    const parentRelative = path.posix.dirname(originalPath) === "." ? "" : path.posix.dirname(originalPath);
    const type = info?.type ?? entryType(await fs.lstat(source));
    await ensureDirectoryPath(parentRelative);
    const { target, renamed } = await availableTarget(parentRelative, path.posix.basename(originalPath), type, "restored");
    await renameAcrossDevices(source, target);
    await fs.rm(path.join(trash!.info, `${id}.json`), { force: true });
    restored.push({ id, path: relativeFromAbsolute(target), renamed });
  }
  return restored;
}

export async function deleteTrashItems(ids: string[]) {
  if (!ids.length) throw new AppError("Choose at least one item", 400);
  const trash = await trashDirectories();
  for (const id of ids) {
    await fs.rm(await existingTrashItem(trash, id), { recursive: true, force: false });
    await fs.rm(path.join(trash!.info, `${id}.json`), { force: true });
  }
  return { removed: ids.length };
}

export async function emptyTrash() {
  const trash = await trashDirectories();
  if (!trash) return { removed: 0 };
  const ids = await fs.readdir(trash.items);
  for (const id of ids) await fs.rm(path.join(trash.items, id), { recursive: true, force: true });
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

// Copies that would collide get a free "name (copy).ext" name; moves never rename and fail on a conflict.
export async function copyOrMove(paths: string[], destinationPath: string, move: boolean): Promise<TransferResult[]> {
  const destination = await safeResolve(destinationPath);
  if (!(await fs.stat(destination)).isDirectory()) throw new AppError("Destination is not a folder", 400);
  const destinationRelative = relativeFromAbsolute(destination);
  const results: TransferResult[] = [];

  for (const sourcePath of paths) {
    try {
      results.push(await transferOne(sourcePath, destination, destinationRelative, move));
    } catch (error) {
      if (results.length) throw new PartialTransferError(error, results, move);
      throw error;
    }
  }
  return results;
}

async function transferOne(sourcePath: string, destination: string, destinationRelative: string, move: boolean): Promise<TransferResult> {
  {
    const source = await safeResolve(sourcePath, { followSymlink: false });
    if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
      throw new AppError(`You can't ${move ? "move" : "copy"} a folder into itself or one of its own subfolders`, 400, "INVALID_DESTINATION");
    }
    const name = path.basename(source);
    let target = path.join(destination, name);
    if (move && target === source) throw new AppError("The item is already in that folder", 409, "SAME_DESTINATION");
    await safeResolve(relativeFromAbsolute(target), { mustExist: false });
    let renamed = false;
    try {
      await fs.lstat(target);
      if (move) throw new AppError("An item with that name already exists in the destination", 409, "NAME_CONFLICT");
      ({ target, renamed } = await availableTarget(destinationRelative, name, entryType(await fs.lstat(source)), "copy"));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (move) await renameAcrossDevices(source, target);
    else await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    return { source: relativeFromAbsolute(source), path: relativeFromAbsolute(target), renamed };
  }
}

export async function changeMode(paths: string[], mode: string) {
  if (!/^[0-7]{3,4}$/.test(mode)) throw new AppError("Permissions must be an octal value such as 755", 400);
  for (const relativePath of paths) await fs.chmod(await safeResolve(relativePath), Number.parseInt(mode, 8));
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
  const { absolute, handle, stat } = await openVerifiedFile(relativePath, "r+");
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
  return toEntry(absolute);
}

function renamedName(original: string, index: number, rule: BulkRenameRule) {
  const extension = path.extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;
  let next = stem;
  if (rule.find) {
    if (rule.regex) {
      try {
        next = next.replace(new RegExp(rule.find, rule.caseSensitive ? "g" : "gi"), rule.replace || "");
      } catch {
        throw new AppError("The bulk rename regular expression is invalid", 400, "INVALID_REGEX");
      }
    } else if (rule.caseSensitive) {
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

export async function previewBulkRename(paths: string[], rule: BulkRenameRule): Promise<RenamePreview[]> {
  const previews: RenamePreview[] = [];
  const destinations = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const source = await safeResolve(paths[index]);
    const from = path.basename(source);
    const to = renamedName(from, index, rule);
    const destination = path.join(path.dirname(source), to);
    let error: string | undefined;
    if (destinations.has(destination)) error = "Duplicate destination";
    destinations.add(destination);
    if (destination !== source) {
      try {
        await fs.access(destination);
        error = "Name already exists";
      } catch {
        // Available.
      }
    }
    previews.push({ source: paths[index], from, to, changed: from !== to, error });
  }
  return previews;
}

export async function applyBulkRename(paths: string[], rule: BulkRenameRule) {
  const previews = await previewBulkRename(paths, rule);
  if (previews.some((item) => item.error)) throw new AppError("Resolve bulk rename conflicts before applying", 409, "RENAME_CONFLICT");

  const staged: Array<{ original: string; temporary: string; destination: string }> = [];
  try {
    for (const preview of previews.filter((item) => item.changed)) {
      const source = await safeResolve(preview.source);
      const temporary = path.join(path.dirname(source), `.filedude-rename-${crypto.randomUUID()}`);
      await fs.rename(source, temporary);
      staged.push({ original: source, temporary, destination: path.join(path.dirname(source), preview.to) });
    }
    for (const item of staged) await fs.rename(item.temporary, item.destination);
  } catch (error) {
    for (const item of [...staged].reverse()) {
      try {
        await fs.access(item.temporary);
        await fs.rename(item.temporary, item.original);
      } catch {
        try {
          await fs.access(item.destination);
          await fs.rename(item.destination, item.original);
        } catch {
          // Best-effort recovery; the audit log records the original operation.
        }
      }
    }
    throw error;
  }
  return previews;
}

export async function details(relativePath: string) {
  return toEntry(await safeResolve(relativePath));
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
    const converted = await Promise.allSettled(page.slice(start, start + 64).map((candidate) => toEntry(candidate.absolute)));
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
