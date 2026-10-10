import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, Stats as RemoteStats } from "ssh2";
import { reservedPathCheck } from "./archives";
import { getConnection } from "./connections";
import { forgetCopies, recordCopy } from "./copy-journal";
import { diskInfo, identityOf, INTERNAL_NAMES, openDirectory, openVerifiedFile, placeEntry, removeCreated, removeIfSame, validateName, withFilesystemLock, type AnchoredDirectory } from "./files";
import { AppError } from "./http";
import { startJob } from "./jobs";
import { abortSession, availableRemoteName, readDirectory, remotePath, removeRemoteTree, sftpCall as call, statRemote, withSftp, writeRemote } from "./sftp";
import type { JobProgress, TransferResult } from "./types";

// Copies between FilesDude and the owner's other servers, as background jobs with progress and
// cancel. A folder from a server is copied into a hidden placeholder that only this service can open
// (so nobody can tamper with it meanwhile), handed to its owner once complete, and then given its
// real name, one nothing has yet; a cancelled or failed copy's placeholder is removed through open
// handles, never by path, and one left by a restart is cleaned up when the service starts. The other
// server is treated as untrusted: entries, bytes, and free space are all checked as the copy goes,
// whatever it reported beforehand, and one that stops responding is disconnected. Links and special
// files are skipped in both directions, as are names that aren't safe here.

const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
// Copying in stops if it would leave less than this free, checked again as the copy goes.
const RESERVE_BYTES = 1024 ** 3;
const SPACE_CHECK_BYTES = 256 * 1024 ** 2;
// A copy with no progress for this long has stalled; its connection is closed. Tests shorten it.
let STALL_MS = 60_000;
export function setStallTimeout(milliseconds?: number) {
  STALL_MS = milliseconds ?? 60_000;
}
const ON_LINUX = process.platform === "linux";
const runningAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

type Local = { base: string; real: string };
const cancelled = () => new AppError("The copy was cancelled", 409, "JOB_CANCELLED");
const childPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/**
 * Progress, limits, and stall detection for one copy. Its signal fires when the job is cancelled or
 * the copy stalls; stalling also disconnects the server so anything waiting on it fails at once.
 */
function tracker(id: string, report: (progress: JobProgress) => void, jobSignal: AbortSignal) {
  const controller = new AbortController();
  const progress: JobProgress = { done: 0, unit: "bytes" };
  let lastProgress = Date.now();
  let stalled = false;
  const stop = () => {
    controller.abort();
    void abortSession(id);
  };
  jobSignal.addEventListener("abort", stop, { once: true });
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress > STALL_MS) {
      stalled = true;
      stop();
    }
  }, Math.min(5_000, STALL_MS / 2));
  return {
    progress,
    signal: controller.signal,
    touch() { lastProgress = Date.now(); },
    report() {
      lastProgress = Date.now();
      report({ ...progress });
    },
    check() {
      if (stalled) throw new AppError("The server stopped responding", 504, "REMOTE_STALLED");
      if (controller.signal.aborted) throw cancelled();
    },
    /** Why a copy that failed stopped, when it was stopped (stalled or cancelled) rather than failing. */
    reason(error: unknown) {
      if (stalled) return new AppError("The server stopped responding", 504, "REMOTE_STALLED");
      if (jobSignal.aborted) return cancelled();
      return error;
    },
    done() {
      clearInterval(watchdog);
      jobSignal.removeEventListener("abort", stop);
    },
  };
}
type Tracker = ReturnType<typeof tracker>;

// Counts bytes as they pass, refusing more than a file's listed size or the copy's measured total.
function meter(track: Tracker, fileLimit: number | undefined, onBytes?: (bytes: number) => Promise<void> | void) {
  let fileBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (track.signal.aborted) return done(cancelled());
      fileBytes += chunk.length;
      track.progress.done += chunk.length;
      if ((fileLimit !== undefined && fileBytes > fileLimit) || (track.progress.total !== undefined && track.progress.done > track.progress.total)) {
        return done(new AppError("The server sent more than it said a file holds, so the copy was stopped", 502, "REMOTE_SIZE_MISMATCH"));
      }
      track.report();
      Promise.resolve(onBytes?.(chunk.length)).then(() => done(null, chunk), (error) => done(error));
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

// A name in a local folder that nothing has yet: "name (1).ext" and so on.
async function availableLocalName(folder: Local, name: string, skip = 0) {
  const extension = name.startsWith(".") && name.indexOf(".", 1) < 0 ? "" : path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = skip; index < 1_000; index += 1) {
    const candidate = index ? `${stem} (${index})${extension}` : name;
    if (!(await fs.lstat(path.join(folder.base, candidate)).then(() => true, () => false))) return { candidate, index };
  }
  throw new AppError("Unable to choose an available name", 409);
}

/** Gives a finished copy (still unreachable by anyone else) to the destination's owner, inside out. */
async function handOver(folder: Local, owner: { uid: number; gid: number }, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) return;
  for (const entry of await fs.readdir(folder.base, { withFileTypes: true })) {
    const location = path.join(folder.base, entry.name);
    if (entry.isDirectory()) {
      const child = await openLocalChild(folder, entry.name);
      try {
        await handOver(child, owner, depth + 1);
        await child.handle.chown(owner.uid, owner.gid);
      } finally {
        await child.handle.close().catch(() => undefined);
      }
    } else if (entry.isFile()) {
      await fs.lchown(location, owner.uid, owner.gid);
    }
  }
}

/** Sizes what's to be copied from the other server, within limits. */
async function measureRemote(sftp: SFTPWrapper, absolutes: string[], track: Tracker) {
  let bytes = 0;
  let entries = 0;
  const visit = async (location: string, stats: RemoteStats, depth: number): Promise<void> => {
    track.check();
    track.touch();
    if ((entries += 1) > MAX_ENTRIES || depth > MAX_DEPTH) throw new AppError("That is too much to copy at once from here", 400, "TOO_LARGE");
    if (stats.isFile()) bytes += Number(stats.size);
    if (!stats.isDirectory()) return;
    const listing = await readDirectory(sftp, location, MAX_ENTRIES - entries + 1, track.signal);
    if (listing.truncated) throw new AppError("That is too much to copy at once from here", 400, "TOO_LARGE");
    // Counted by the same rules as the copy, so progress reaches its total.
    for (const entry of listing.entries) {
      const name = safeLocalName(entry.filename);
      if (name && !INTERNAL_NAMES.has(name)) await visit(path.posix.join(location, entry.filename), entry.attrs, depth + 1);
    }
  };
  for (const absolute of absolutes) await visit(absolute, await statRemote(sftp, absolute), 0);
  return bytes;
}

/** Copies files and folders from another server into a folder here. */
async function copyFromServer(id: string, paths: string[], destination: string, report: (progress: JobProgress) => void, jobSignal: AbortSignal): Promise<TransferResult[]> {
  const target = await withFilesystemLock(() => openDirectory(destination));
  // New items take the owner of the folder they're copied into, as other new items do.
  const owner = runningAsRoot() ? { uid: target.stat.uid, gid: target.stat.gid } : null;
  const into: Local = { base: target.base, real: target.real };
  const results: TransferResult[] = [];
  const track = tracker(id, report, jobSignal);
  try {
    return await withSftp(id, async (sftp, root) => {
      const sources = paths.map((relative) => ({ relative, absolute: remotePath(root, relative) }));
      const total = await measureRemote(sftp, sources.map((source) => source.absolute), track);
      if (total + RESERVE_BYTES > (await diskInfo()).available) throw new AppError("There isn't enough free space here for that copy", 507, "NOT_ENOUGH_SPACE");
      track.progress.total = total;
      track.report();
      let sinceSpaceCheck = 0;
      // Free space is checked again as data arrives, whatever the server said beforehand.
      const spaceCheck = async (bytes: number) => {
        sinceSpaceCheck += bytes;
        if (sinceSpaceCheck < SPACE_CHECK_BYTES) return;
        sinceSpaceCheck = 0;
        if ((await diskInfo()).available < RESERVE_BYTES) throw new AppError("There isn't enough free space here to continue that copy", 507, "NOT_ENOUGH_SPACE");
      };
      let entries = 0;

      const copyFile = async (absolute: string, folder: Local, name: string, size: number) => {
        const handle = await fs.open(path.join(folder.base, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
        await pipeline(sftp.createReadStream(absolute), meter(track, size, spaceCheck), handle.createWriteStream(), { signal: track.signal });
      };
      const mirror = async (absolute: string, folder: Local, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) throw new AppError("Folders nested that deeply can't be copied", 400, "TREE_TOO_DEEP");
        // Listed again here, and counted again: the server may answer differently than when measured.
        const listing = await readDirectory(sftp, absolute, MAX_ENTRIES - entries + 1, track.signal);
        entries += listing.entries.length;
        if (listing.truncated || entries > MAX_ENTRIES) throw new AppError("That is too much to copy at once from here", 400, "TOO_LARGE");
        for (const entry of listing.entries) {
          track.check();
          const name = safeLocalName(entry.filename);
          if (!name || INTERNAL_NAMES.has(name)) continue;
          const source = path.posix.join(absolute, entry.filename);
          if (entry.attrs.isDirectory()) {
            await fs.mkdir(path.join(folder.base, name));
            const child = await openLocalChild(folder, name);
            try {
              await mirror(source, child, depth + 1);
            } finally {
              await child.handle.close().catch(() => undefined);
            }
          } else if (entry.attrs.isFile()) {
            await copyFile(source, folder, name, Number(entry.attrs.size));
          }
        }
      };

      for (const source of sources) {
        track.check();
        const stats = await statRemote(sftp, source.absolute);
        const name = safeLocalName(path.posix.basename(source.absolute));
        if (!name) throw new AppError(`“${path.posix.basename(source.absolute)}” can't be copied here under that name`, 400, "INVALID_NAME");
        if (stats.isFile()) {
          const { candidate } = await withFilesystemLock(() => availableLocalName(into, name));
          const handle = await fs.open(path.join(into.base, candidate), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
          const created = await handle.stat();
          try {
            await pipeline(sftp.createReadStream(source.absolute), meter(track, Number(stats.size), spaceCheck), handle.createWriteStream(), { signal: track.signal });
            if (owner) await fs.lchown(path.join(into.base, candidate), owner.uid, owner.gid).catch(() => undefined);
          } catch (error) {
            await handle.close().catch(() => undefined);
            await removeIfSame(target, candidate, created);
            throw error;
          }
          results.push({ source: source.relative, path: childPath(destination, candidate), renamed: candidate !== name });
        } else if (stats.isDirectory()) {
          const placeholder = `.filesdude-copying-${crypto.randomUUID()}`;
          const journalId = crypto.randomUUID();
          // Only this service can open the placeholder while it fills, whoever owns the folder.
          await fs.mkdir(path.join(into.base, placeholder), { mode: 0o700 });
          const folder = await openLocalChild(into, placeholder);
          const identity = identityOf(await folder.handle.stat());
          await recordCopy({ id: journalId, directory: into.real, name: placeholder, identity, startedAt: new Date().toISOString() }).catch(() => undefined);
          try {
            await folder.handle.chmod(0o700);
            await mirror(source.absolute, folder, 1);
            track.check();
            if (owner) {
              await handOver(folder, owner);
              await folder.handle.chown(owner.uid, owner.gid);
            }
            await folder.handle.chmod(0o777 & ~process.umask());
            const chosen = await withFilesystemLock(async () => {
              for (let skip = 0; ; skip += 1) {
                const { candidate, index } = await availableLocalName(into, name, skip);
                try {
                  await placeEntry(target, placeholder, target, candidate);
                  return candidate;
                } catch (error) {
                  if (!(error instanceof AppError && error.code === "NAME_CONFLICT")) throw error;
                  skip = index;
                }
              }
            });
            results.push({ source: source.relative, path: childPath(destination, chosen), renamed: chosen !== name });
          } catch (error) {
            await removeCreated(target, placeholder, identity).catch(() => undefined);
            throw error;
          } finally {
            await folder.handle.close().catch(() => undefined);
            await forgetCopies([journalId]).catch(() => undefined);
          }
        } else {
          throw new AppError(`“${name}” is a link or special file, which isn't copied`, 400, "UNSUPPORTED_FILE_TYPE");
        }
      }
      return results;
    });
  } catch (error) {
    const failure = track.reason(error);
    throw Object.assign(failure instanceof AppError ? failure : new AppError("The copy failed", 500), { completed: results });
  } finally {
    track.done();
    await target.handle.close().catch(() => undefined);
  }
}

type LocalSource = { kind: "file"; handle: FileHandle; stat: Stats; name: string; relative: string } | { kind: "directory"; folder: AnchoredDirectory; name: string; relative: string };

/** Copies files and folders from here into a folder on another server. */
async function copyToServer(id: string, paths: string[], destination: string, report: (progress: JobProgress) => void, jobSignal: AbortSignal): Promise<TransferResult[]> {
  const isReserved = await reservedPathCheck();
  const results: TransferResult[] = [];
  const track = tracker(id, report, jobSignal);
  try {
    return await withSftp(id, async (sftp, root) => {
      const into = remotePath(root, destination);
      if (!(await statRemote(sftp, into)).isDirectory()) throw new AppError("Choose a folder on the server to copy into", 400, "NOT_A_DIRECTORY");
      track.report();
      let entries = 0;

      const sendFile = (folder: string, name: string, handle: FileHandle, size: number) =>
        writeRemote(sftp, folder, name, (stream) => pipeline(handle.createReadStream({ start: 0, end: Math.max(0, size - 1) }), meter(track, size), stream, { signal: track.signal }));
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
          track.check();
          if (isDirectory) {
            const child = await openLocalChild(local, name).catch(() => null);
            if (!child) continue;
            try {
              const folder = path.posix.join(remote, name);
              await call<void>((done) => sftp.mkdir(folder, done));
              track.touch();
              await mirror(child, folder, depth + 1);
            } finally {
              await child.handle.close().catch(() => undefined);
            }
          } else {
            const handle = await fs.open(path.join(local.base, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
            if (!handle) continue;
            try {
              const stat = await handle.stat();
              if (stat.isFile()) await sendFile(remote, name, handle, stat.size);
            } finally {
              await handle.close().catch(() => undefined);
            }
          }
        }
      };

      for (const relative of paths) {
        track.check();
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
            const chosen = await sendFile(into, source.name, source.handle, source.stat.size);
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
    const failure = track.reason(error);
    throw Object.assign(failure instanceof AppError ? failure : new AppError("The copy failed", 500), { completed: results });
  } finally {
    track.done();
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
