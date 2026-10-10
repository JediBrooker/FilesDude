import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntryWithStats, SFTPWrapper, Stats as RemoteStats } from "ssh2";
import { reservedPathCheck } from "./archives";
import { getConnection } from "./connections";
import { diskInfo, INTERNAL_NAMES, openDirectory, openVerifiedFile, validateName, withFilesystemLock, type AnchoredDirectory } from "./files";
import { AppError } from "./http";
import { startJob } from "./jobs";
import { availableRemoteName, remotePath, removeRemoteTree, sftpCall as call, statRemote, withSftp, writeRemote } from "./sftp";
import type { JobProgress, TransferResult } from "./types";

// Copies between FilesDude and the owner's other servers, as background jobs with progress and
// cancel. A folder is copied into a hidden placeholder and given its real name (one nothing has yet)
// only once complete, so a cancelled or failed copy leaves nothing half-done behind. Links and special
// files are skipped in both directions, as are names that aren't safe here.

const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
// Copying in stops if it would leave less than this free.
const RESERVE_BYTES = 1024 ** 3;
const ON_LINUX = process.platform === "linux";
const runningAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

type Local = { base: string; real: string };
const cancelled = () => new AppError("The copy was cancelled", 409, "JOB_CANCELLED");
const childPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

function meter(progress: JobProgress, report: (progress: JobProgress) => void, signal: AbortSignal) {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (signal.aborted) return done(cancelled());
      progress.done += chunk.length;
      report({ ...progress });
      done(null, chunk);
    },
  });
}

// A name from the other server that's safe to create here, or null to skip it.
function safeLocalName(name: string) {
  try {
    const valid = validateName(name);
    return valid === name && Buffer.byteLength(name) <= 255 ? name : null;
  } catch {
    return null;
  }
}

async function openLocalChild(folder: Local, name: string): Promise<Local & { handle: FileHandle }> {
  const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const real = path.join(folder.real, name);
  return { handle, real, base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : real };
}

async function newLocalFile(folder: Local, name: string, owner: { uid: number; gid: number } | null) {
  const handle = await fs.open(path.join(folder.base, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  if (owner) await handle.chown(owner.uid, owner.gid).catch(() => undefined);
  return handle;
}

// A name in a local folder that nothing has yet: "name (1).ext" and so on.
async function availableLocalName(folder: Local, name: string) {
  const extension = name.startsWith(".") && name.indexOf(".", 1) < 0 ? "" : path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = index ? `${stem} (${index})${extension}` : name;
    if (!(await fs.lstat(path.join(folder.base, candidate)).then(() => true, () => false))) return candidate;
  }
  throw new AppError("Unable to choose an available name", 409);
}

/** Sizes what's to be copied from the other server, within limits. */
async function measureRemote(sftp: SFTPWrapper, absolutes: string[], signal: AbortSignal) {
  let bytes = 0;
  let entries = 0;
  const visit = async (location: string, stats: RemoteStats, depth: number): Promise<void> => {
    if (signal.aborted) throw cancelled();
    if ((entries += 1) > MAX_ENTRIES || depth > MAX_DEPTH) throw new AppError("That is too much to copy at once from here", 400, "TOO_LARGE");
    if (stats.isFile()) bytes += Number(stats.size);
    if (!stats.isDirectory()) return;
    // Counted by the same rules as the copy, so progress reaches its total.
    for (const entry of await call<FileEntryWithStats[]>((done) => sftp.readdir(location, done))) {
      const name = safeLocalName(entry.filename);
      if (name && !INTERNAL_NAMES.has(name)) await visit(path.posix.join(location, entry.filename), entry.attrs, depth + 1);
    }
  };
  for (const absolute of absolutes) await visit(absolute, await statRemote(sftp, absolute), 0);
  return bytes;
}

/** Copies files and folders from another server into a folder here. */
async function copyFromServer(id: string, paths: string[], destination: string, report: (progress: JobProgress) => void, signal: AbortSignal): Promise<TransferResult[]> {
  const target = await withFilesystemLock(() => openDirectory(destination));
  // New items take the owner of the folder they're copied into, as other new items do.
  const owner = runningAsRoot() ? { uid: target.stat.uid, gid: target.stat.gid } : null;
  const results: TransferResult[] = [];
  try {
    return await withSftp(id, async (sftp, root) => {
      const sources = paths.map((relative) => ({ relative, absolute: remotePath(root, relative) }));
      const total = await measureRemote(sftp, sources.map((source) => source.absolute), signal);
      if (total + RESERVE_BYTES > (await diskInfo()).available) throw new AppError("There isn't enough free space here for that copy", 507, "NOT_ENOUGH_SPACE");
      const progress: JobProgress = { done: 0, total, unit: "bytes" };
      report({ ...progress });

      const copyFile = async (absolute: string, folder: Local, name: string) => {
        const handle = await newLocalFile(folder, name, owner);
        const created = await handle.stat();
        try {
          await pipeline(sftp.createReadStream(absolute), meter(progress, report, signal), handle.createWriteStream());
        } catch (error) {
          await handle.close().catch(() => undefined);
          const current = await fs.lstat(path.join(folder.base, name)).catch(() => null);
          if (current && current.ino === created.ino && current.dev === created.dev) await fs.rm(path.join(folder.base, name), { force: true });
          throw error;
        }
      };
      const mirror = async (absolute: string, folder: Local, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) throw new AppError("Folders nested that deeply can't be copied", 400, "TREE_TOO_DEEP");
        for (const entry of await call<FileEntryWithStats[]>((done) => sftp.readdir(absolute, done))) {
          if (signal.aborted) throw cancelled();
          const name = safeLocalName(entry.filename);
          if (!name || INTERNAL_NAMES.has(name)) continue;
          const source = path.posix.join(absolute, entry.filename);
          if (entry.attrs.isDirectory()) {
            await fs.mkdir(path.join(folder.base, name));
            const child = await openLocalChild(folder, name);
            try {
              if (owner) await child.handle.chown(owner.uid, owner.gid).catch(() => undefined);
              await mirror(source, child, depth + 1);
            } finally {
              await child.handle.close().catch(() => undefined);
            }
          } else if (entry.attrs.isFile()) {
            await copyFile(source, folder, name);
          }
        }
      };

      const into: Local = { base: target.base, real: target.real };
      for (const source of sources) {
        if (signal.aborted) throw cancelled();
        const stats = await statRemote(sftp, source.absolute);
        const name = safeLocalName(path.posix.basename(source.absolute));
        if (!name) throw new AppError(`“${path.posix.basename(source.absolute)}” can't be copied here under that name`, 400, "INVALID_NAME");
        if (stats.isFile()) {
          const chosen = await withFilesystemLock(() => availableLocalName(into, name));
          await copyFile(source.absolute, into, chosen);
          results.push({ source: source.relative, path: childPath(destination, chosen), renamed: chosen !== name });
        } else if (stats.isDirectory()) {
          const placeholder = `.filesdude-copying-${crypto.randomUUID()}`;
          await fs.mkdir(path.join(into.base, placeholder));
          try {
            const folder = await openLocalChild(into, placeholder);
            try {
              if (owner) await folder.handle.chown(owner.uid, owner.gid).catch(() => undefined);
              await mirror(source.absolute, folder, 1);
            } finally {
              await folder.handle.close().catch(() => undefined);
            }
            const chosen = await withFilesystemLock(async () => {
              const free = await availableLocalName(into, name);
              await fs.rename(path.join(into.base, placeholder), path.join(into.base, free));
              return free;
            });
            results.push({ source: source.relative, path: childPath(destination, chosen), renamed: chosen !== name });
          } catch (error) {
            await fs.rm(path.join(into.base, placeholder), { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
        } else {
          throw new AppError(`“${name}” is a link or special file, which isn't copied`, 400, "UNSUPPORTED_FILE_TYPE");
        }
      }
      return results;
    });
  } catch (error) {
    throw Object.assign(error instanceof AppError ? error : new AppError((error as Error).message, 500), { completed: results });
  } finally {
    await target.handle.close().catch(() => undefined);
  }
}

type LocalSource = { kind: "file"; handle: FileHandle; stat: Stats; name: string; relative: string } | { kind: "directory"; folder: AnchoredDirectory; name: string; relative: string };

/** Copies files and folders from here into a folder on another server. */
async function copyToServer(id: string, paths: string[], destination: string, report: (progress: JobProgress) => void, signal: AbortSignal): Promise<TransferResult[]> {
  const isReserved = await reservedPathCheck();
  const results: TransferResult[] = [];
  try {
    return await withSftp(id, async (sftp, root) => {
      const into = remotePath(root, destination);
      if (!(await statRemote(sftp, into)).isDirectory()) throw new AppError("Choose a folder on the server to copy into", 400, "NOT_A_DIRECTORY");
      const progress: JobProgress = { done: 0, unit: "bytes" };
      report({ ...progress });
      let entries = 0;

      const sendFile = (folder: string, name: string, handle: FileHandle) =>
        writeRemote(sftp, folder, name, (stream) => pipeline(handle.createReadStream(), meter(progress, report, signal), stream));
      const mirror = async (local: Local, remote: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) throw new AppError("Folders nested that deeply can't be copied", 400, "TREE_TOO_DEEP");
        const directory = await fs.opendir(local.base);
        const names: Array<{ name: string; isDirectory: boolean }> = [];
        try {
          for await (const entry of directory) {
            if ((entries += 1) > MAX_ENTRIES) throw new AppError("That is too much to copy at once", 400, "TOO_LARGE");
            if (INTERNAL_NAMES.has(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue;
            if (entry.isDirectory() && isReserved(path.join(local.real, entry.name))) continue;
            names.push({ name: entry.name, isDirectory: entry.isDirectory() });
          }
        } finally {
          await directory.close().catch(() => undefined);
        }
        for (const { name, isDirectory } of names) {
          if (signal.aborted) throw cancelled();
          if (isDirectory) {
            const child = await openLocalChild(local, name).catch(() => null);
            if (!child) continue;
            try {
              const folder = path.posix.join(remote, name);
              await call<void>((done) => sftp.mkdir(folder, done));
              await mirror(child, folder, depth + 1);
            } finally {
              await child.handle.close().catch(() => undefined);
            }
          } else {
            const handle = await fs.open(path.join(local.base, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
            if (!handle) continue;
            try {
              if ((await handle.stat()).isFile()) await sendFile(remote, name, handle);
            } finally {
              await handle.close().catch(() => undefined);
            }
          }
        }
      };

      for (const relative of paths) {
        if (signal.aborted) throw cancelled();
        const source = await withFilesystemLock(async (): Promise<LocalSource> => {
          const opened = await openVerifiedFile(relative);
          const name = path.basename(opened.absolute);
          if (isReserved(opened.openedPath)) {
            await opened.handle.close();
            throw new AppError("That item is reserved by FilesDude", 403, "RESERVED_PATH");
          }
          if (opened.stat.isFile()) return { kind: "file", handle: opened.handle, stat: opened.stat, name, relative };
          await opened.handle.close();
          if (opened.stat.isDirectory()) return { kind: "directory", folder: await openDirectory(relative), name, relative };
          throw new AppError(`“${name}” is a link or special file, which isn't copied`, 400, "UNSUPPORTED_FILE_TYPE");
        });
        if (source.kind === "file") {
          try {
            const chosen = await sendFile(into, source.name, source.handle);
            results.push({ source: relative, path: childPath(destination, chosen), renamed: chosen !== source.name });
          } finally {
            await source.handle.close().catch(() => undefined);
          }
          continue;
        }
        const placeholder = path.posix.join(into, `.filesdude-partial-${crypto.randomUUID()}`);
        try {
          await call<void>((done) => sftp.mkdir(placeholder, done));
          await mirror({ base: source.folder.base, real: source.folder.real }, placeholder, 1);
          const chosen = await availableRemoteName(sftp, into, source.name);
          await call<void>((done) => sftp.rename(placeholder, path.posix.join(into, chosen), done));
          results.push({ source: relative, path: childPath(destination, chosen), renamed: chosen !== source.name });
        } catch (error) {
          await removeRemoteTree(sftp, placeholder).catch(() => undefined);
          throw error;
        } finally {
          await source.folder.handle.close().catch(() => undefined);
        }
      }
      return results;
    });
  } catch (error) {
    throw Object.assign(error instanceof AppError ? error : new AppError((error as Error).message, 500), { completed: results });
  }
}

const subject = (paths: string[]) => (paths.length === 1 ? path.posix.basename(paths[0]) || "the starting folder" : `${paths.length} items`);

function checkPaths(paths: unknown) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1_000 || paths.some((item) => typeof item !== "string" || item.length > 4096)) throw new AppError("Choose between 1 and 1,000 items", 400, "INVALID_PATHS");
  return paths as string[];
}

/** Starts copying from another server into a folder here. */
export async function startCopyFromServer(id: string, paths: unknown, destination: string, onFinish: (job: { status: string; error?: string; transferred?: TransferResult[] }, name: string) => void) {
  const chosen = checkPaths(paths);
  const { name } = await getConnection(id);
  return startJob("copy", `Copying ${subject(chosen)} from ${name}`, { done: 0, unit: "bytes" }, (report, signal) => copyFromServer(id, chosen, destination, report, signal), (job) => onFinish(job, name));
}

/** Starts copying items from here into a folder on another server. */
export async function startCopyToServer(id: string, paths: unknown, destination: string, onFinish: (job: { status: string; error?: string; transferred?: TransferResult[] }, name: string) => void) {
  const chosen = checkPaths(paths);
  const { name } = await getConnection(id);
  return startJob("send", `Copying ${subject(chosen)} to ${name}`, { done: 0, unit: "bytes" }, (report, signal) => copyToServer(id, chosen, destination, report, signal), (job) => onFinish(job, name));
}
