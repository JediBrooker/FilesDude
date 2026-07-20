import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { AppError } from "./http";
import type { BulkRenameRule, DiskInfo, FileEntry, IdentityOption, LargestFilesResult, OwnershipPair, RenamePreview } from "./types";

const INTERNAL_NAMES = new Set([".filedude"]);
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
let largestFilesScan: Promise<LargestFilesIndex> | null = null;
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

function relativeFromAbsolute(absolute: string) {
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

function validateName(name: string) {
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

export async function deleteEntries(paths: string[], permanent = false) {
  if (!paths.length) throw new AppError("Choose at least one item", 400);
  const root = await ensureRoot();
  const trash = path.join(root, ".filedude", "trash");
  if (!permanent && config.trashEnabled) await fs.mkdir(trash, { recursive: true, mode: 0o700 });

  for (const relativePath of paths) {
    const source = await safeResolve(relativePath, { followSymlink: false });
    if (source === root) throw new AppError("The configured root cannot be deleted", 403);
    if (!permanent && config.trashEnabled) {
      const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      await renameAcrossDevices(source, path.join(trash, `${path.basename(source)}.${suffix}`));
    } else {
      await fs.rm(source, { recursive: true, force: false });
    }
  }
}

export async function copyOrMove(paths: string[], destinationPath: string, move: boolean) {
  const destination = await safeResolve(destinationPath);
  if (!(await fs.stat(destination)).isDirectory()) throw new AppError("Destination is not a folder", 400);

  for (const sourcePath of paths) {
    const source = await safeResolve(sourcePath, { followSymlink: false });
    const target = path.join(destination, path.basename(source));
    if (target === source) throw new AppError("The item is already in that folder", 409, "SAME_DESTINATION");
    await safeResolve(relativeFromAbsolute(target), { mustExist: false });
    try {
      await fs.access(target);
      throw new AppError("An item with that name already exists in the destination", 409, "NAME_CONFLICT");
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (move) await renameAcrossDevices(source, target);
    else await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
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

async function scanLargestFiles(): Promise<LargestFilesIndex> {
  const startedAt = Date.now();
  const root = await ensureRoot();
  const directoryQueue = [root];
  const candidates: LargestCandidate[] = [];
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let skippedEntries = 0;

  while (directoryQueue.length) {
    const batch = directoryQueue.splice(0, 4);
    const discovered = await Promise.all(batch.map(async (directory) => {
      scannedDirectories += 1;
      let entries: Dirent[];
      try {
        const directoryStat = await fs.lstat(directory);
        const realDirectory = await fs.realpath(directory);
        if (!directoryStat.isDirectory() || !insideRoot(realDirectory)) throw new Error("Directory is no longer safe to scan");
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        skippedEntries += 1;
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
            skippedEntries += 1;
            continue;
          }
          if (item.value.stat.isDirectory()) directories.push(item.value.absolute);
          else if (item.value.stat.isFile()) {
            scannedFiles += 1;
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
    scannedFiles,
    scannedDirectories,
    skippedEntries,
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
}

export async function largestFiles({ refresh = false, minBytes = 0, offset = 0, limit = 100 }: { refresh?: boolean; minBytes?: number; offset?: number; limit?: number } = {}): Promise<LargestFilesResult> {
  let index: LargestFilesIndex;
  let cached = false;
  if (!refresh && largestFilesCache && Date.now() - largestFilesCache.at < 5 * 60_000) {
    index = largestFilesCache.index;
    cached = true;
  } else {
    if (!largestFilesScan) {
      largestFilesScan = scanLargestFiles()
        .then((value) => {
          largestFilesCache = { at: Date.now(), index: value };
          return value;
        })
        .finally(() => { largestFilesScan = null; });
    }
    index = await largestFilesScan;
  }

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
