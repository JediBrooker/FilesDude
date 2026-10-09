import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { config } from "./config";
import { ensureRoot, getMime, INTERNAL_NAMES, normalizeRelative } from "./files";
import { AppError } from "./http";
import { withinScope } from "./scope";

// ZFS snapshots of the dataset holding FILEDUDE_ROOT. Snapshots are read-only and never change, so
// an item inside one is checked once by its real path (no link anywhere on the way) and then read
// freely. FilesDude only ever deletes snapshots it made itself (named "filesdude-..."); others, such
// as Proxmox's, are listed and browsable but left alone.

export type SnapshotKind = "auto" | "manual" | "other";
export interface Snapshot { name: string; createdAt: string; used: number; kind: SnapshotKind }
export interface SnapshotEntry { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number; modified: string; mime: string }
export interface SnapshotVersion { snapshot: string; snapshotCreatedAt: string; type: SnapshotEntry["type"]; size: number; modified: string }
type Dataset = { dataset: string; mountpoint: string; offset: string };

export type ZfsRunner = (args: string[]) => Promise<string>;
const ZFS_BINARIES = ["/usr/sbin/zfs", "/sbin/zfs", "/usr/local/sbin/zfs"];
const INFO_CACHE_MS = 30_000;
// Previous versions look through at most this many of the newest snapshots: each look mounts one.
const MAX_VERSION_SNAPSHOTS = 100;
let runner: ZfsRunner | null | undefined;
let cachedDataset: { at: number; value: Dataset | null } | null = null;
let cachedSnapshots: { at: number; value: Snapshot[] } | null = null;

/** Replaces how zfs is run (tests use a fake); null means ZFS isn't available. */
export function setZfsRunner(replacement: ZfsRunner | null) {
  runner = replacement;
  cachedDataset = null;
  cachedSnapshots = null;
}

async function zfs(): Promise<ZfsRunner | null> {
  if (runner !== undefined) return runner;
  // FILEDUDE_ZFS_PATH names the zfs command when it is somewhere other than the usual places.
  for (const binary of [process.env.FILEDUDE_ZFS_PATH, ...ZFS_BINARIES].filter((item): item is string => Boolean(item))) {
    if (await fs.access(binary, fsConstants.X_OK).then(() => true, () => false)) {
      runner = (args) => new Promise((resolve, reject) => {
        execFile(binary, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
          if (error) reject(new AppError(String(stderr).trim().split("\n")[0] || "The zfs command failed", 500, "ZFS_FAILED"));
          else resolve(String(stdout));
        });
      });
      return runner;
    }
  }
  runner = null;
  return null;
}

const rows = (output: string) => output.split("\n").filter(Boolean).map((line) => line.split("\t"));

/** The dataset whose mountpoint holds the root (the deepest one), or null if the root isn't on ZFS. */
async function findDataset(): Promise<Dataset | null> {
  if (cachedDataset && Date.now() - cachedDataset.at < INFO_CACHE_MS) return cachedDataset.value;
  const run = await zfs();
  let value: Dataset | null = null;
  if (run) {
    const root = await ensureRoot();
    const output = await run(["list", "-H", "-p", "-o", "name,mountpoint", "-t", "filesystem"]).catch(() => "");
    for (const [dataset, mountpoint] of rows(output)) {
      if (!dataset || !mountpoint?.startsWith("/")) continue;
      const inside = root === mountpoint || root.startsWith(`${mountpoint === "/" ? "" : mountpoint}/`);
      if (inside && (!value || mountpoint.length > value.mountpoint.length)) value = { dataset, mountpoint, offset: path.relative(mountpoint, root) };
    }
  }
  cachedDataset = { at: Date.now(), value };
  return value;
}

function kindOf(name: string): SnapshotKind {
  if (name.startsWith("filesdude-auto-")) return "auto";
  if (name.startsWith("filesdude-manual-")) return "manual";
  return "other";
}

async function requireDataset() {
  const dataset = await findDataset();
  if (!dataset) throw new AppError("Snapshots need the root folder to be on ZFS", 404, "SNAPSHOTS_UNAVAILABLE");
  return dataset;
}

/** Whether snapshots are available, and the dataset they are of. */
export async function snapshotSupport() {
  const dataset = await findDataset();
  return dataset ? { available: true as const, dataset: dataset.dataset } : { available: false as const };
}

/** The dataset's snapshots, newest first. */
export async function listSnapshots(fresh = false): Promise<Snapshot[]> {
  if (!fresh && cachedSnapshots && Date.now() - cachedSnapshots.at < INFO_CACHE_MS) return cachedSnapshots.value;
  const { dataset } = await requireDataset();
  const run = (await zfs())!;
  const output = await run(["list", "-H", "-p", "-t", "snapshot", "-d", "1", "-o", "name,creation,used", "-s", "creation", dataset]);
  const value = rows(output)
    .filter(([full]) => full?.startsWith(`${dataset}@`))
    .map(([full, creation, used]) => {
      const name = full.slice(dataset.length + 1);
      return { name, createdAt: new Date(Number(creation) * 1000).toISOString(), used: Number(used) || 0, kind: kindOf(name) };
    })
    .reverse();
  cachedSnapshots = { at: Date.now(), value };
  return value;
}

const pad = (value: number) => String(value).padStart(2, "0");
const stamp = (date: Date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

/** Takes a snapshot named filesdude-<kind>-<UTC time>. */
export async function createSnapshot(kind: "auto" | "manual", now = new Date()) {
  const { dataset } = await requireDataset();
  const run = (await zfs())!;
  const existing = new Set((await listSnapshots(true)).map((snapshot) => snapshot.name));
  let name = `filesdude-${kind}-${stamp(now)}`;
  for (let index = 2; existing.has(name); index += 1) name = `filesdude-${kind}-${stamp(now)}-${index}`;
  await run(["snapshot", `${dataset}@${name}`]);
  cachedSnapshots = null;
  return (await listSnapshots(true)).find((snapshot) => snapshot.name === name)!;
}

/** Deletes one of FilesDude's own snapshots; any other is refused. */
export async function deleteSnapshot(name: string) {
  const { dataset } = await requireDataset();
  const snapshot = (await listSnapshots(true)).find((item) => item.name === name);
  if (!snapshot) throw new AppError("That snapshot no longer exists", 404, "NOT_FOUND");
  if (snapshot.kind === "other") throw new AppError("FilesDude only deletes snapshots it made", 403, "FORBIDDEN");
  await (await zfs())!(["destroy", `${dataset}@${snapshot.name}`]);
  cachedSnapshots = null;
  return snapshot;
}

function entryType(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SnapshotEntry["type"] {
  return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
}

/**
 * Finds an item inside a snapshot by its path relative to the root. The path must be inside the
 * signed-in account's folder and outside FilesDude's own folders, and no part of it inside the
 * snapshot may be a link. Returns the item's location, the real folder holding it, and its details.
 */
export async function snapshotItem(snapshotName: string, relativePath: string) {
  const dataset = await requireDataset();
  // From the cached list, so asking for names that don't exist can't make zfs run on every request.
  const snapshot = (await listSnapshots()).find((item) => item.name === snapshotName);
  if (!snapshot) throw new AppError("That snapshot no longer exists", 404, "NOT_FOUND");
  const relative = normalizeRelative(relativePath).replace(/\/+$/, "");
  if (!withinScope(relative)) throw new AppError("That location is outside your folder", 403, "OUTSIDE_SCOPE");
  const reserved = new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
  if (relative.split("/").some((part) => INTERNAL_NAMES.has(part))) throw reserved;
  // A state folder inside the root (FILEDUDE_STATE_DIR) is as private in a snapshot as it is live.
  const stateRelative = path.relative(await ensureRoot(), path.resolve(config.stateDir)).split(path.sep).join("/");
  if (stateRelative && !stateRelative.startsWith("..") && !path.isAbsolute(stateRelative) && (relative === stateRelative || relative.startsWith(`${stateRelative}/`))) throw reserved;
  const base = path.join(dataset.mountpoint, ".zfs", "snapshot", snapshot.name, dataset.offset);
  const location = relative ? path.join(base, ...relative.split("/")) : base;
  const folder = path.dirname(location);
  const notFound = () => new AppError("That item isn't in this snapshot", 404, "NOT_FOUND");
  const realFolder = await fs.realpath(relative ? folder : location).catch(() => null);
  if (!realFolder) throw notFound();
  if (realFolder !== (relative ? folder : location)) throw new AppError("That path goes through a link in the snapshot", 403, "SNAPSHOT_LINK");
  const stat = await fs.lstat(location).catch(() => null);
  if (!stat) throw notFound();
  return { snapshot, relative, location, folder, name: path.basename(location), stat };
}

/** Checks an opened handle is inside `base` (a folder in a snapshot), for walking it as an archive. */
export function snapshotHandleVerifier(base: string) {
  return async (handle: FileHandle, location: string) => {
    const openedPath = process.platform === "linux" ? await fs.realpath(`/proc/self/fd/${handle.fd}`) : await fs.realpath(location);
    if (openedPath !== base && !openedPath.startsWith(`${base}/`)) throw new AppError("That item isn't inside the snapshot folder", 403, "PATH_OUTSIDE_ROOT");
    return { openedPath, stat: await handle.stat() };
  };
}

const toEntry = (name: string, relative: string, stat: Awaited<ReturnType<typeof fs.lstat>>): SnapshotEntry => {
  const type = entryType(stat);
  return { name, path: relative, type, size: Number(stat.size), modified: stat.mtime.toISOString(), mime: type === "file" ? getMime(name) : "inode/directory" };
};

/** The contents of a folder inside a snapshot. */
export async function listSnapshotFolder(snapshotName: string, relativePath: string, showHidden = false) {
  const item = await snapshotItem(snapshotName, relativePath);
  if (!item.stat.isDirectory()) throw new AppError("Path is not a folder", 400, "NOT_A_DIRECTORY");
  const names = (await fs.readdir(item.location)).filter((name) => !INTERNAL_NAMES.has(name) && (showHidden || !name.startsWith(".")));
  const entries: SnapshotEntry[] = [];
  for (const name of names) {
    const stat = await fs.lstat(path.join(item.location, name)).catch(() => null);
    if (stat) entries.push(toEntry(name, item.relative ? `${item.relative}/${name}` : name, stat));
  }
  entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { snapshot: item.snapshot, path: item.relative, entries };
}

/**
 * The earlier versions of an item kept in snapshots, newest first: one per distinct version (same
 * type, size, and modification time count as the same), leaving out any identical to the item now.
 */
export async function itemVersions(relativePath: string, current: { size: number; modified: string } | null) {
  const versions: SnapshotVersion[] = [];
  let previous = current ? `${current.size}:${current.modified}` : "";
  for (const snapshot of (await listSnapshots()).slice(0, MAX_VERSION_SNAPSHOTS)) {
    const item = await snapshotItem(snapshot.name, relativePath).catch((error: unknown) => {
      if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "SNAPSHOT_LINK")) return null;
      throw error;
    });
    if (!item) continue;
    const entry = toEntry(item.name, item.relative, item.stat);
    const key = `${entry.size}:${entry.modified}`;
    if (entry.type !== "directory" && key === previous) continue;
    previous = key;
    versions.push({ snapshot: snapshot.name, snapshotCreatedAt: snapshot.createdAt, type: entry.type, size: entry.size, modified: entry.modified });
  }
  return versions;
}
