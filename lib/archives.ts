import fs, { constants, type Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { TarArchive, ZipArchive, type Archiver } from "archiver";
import tarStream from "tar-stream";
import yauzl from "yauzl";
import { config } from "./config";
import { AppError } from "./http";
import { acquireFilesystemLock, ensureRoot, INTERNAL_NAMES, measureTree, openVerifiedFile, relativeFromAbsolute, safeResolve, validateName, verifyFileHandleWithinRoot } from "./files";
import type { ArchiveFormat, ArchiveResult, JobProgress } from "./types";

// Threat model: the service usually runs as root over a folder that other users (for example an
// LXC container's users) can also change. A path that was checked can be swapped for a symlink a
// moment later, so long-running work never re-resolves a path an outside user controls. Work
// happens through open directory handles (/proc/self/fd/N on Linux), inside folders only root can
// write to, and ownership is handed over last.

export type ProgressReporter = (progress: JobProgress) => void;

const ARCHIVE_EXTENSION = /\.(zip|tar\.gz|tgz|tar)$/i;
const MAX_EXTRACT_ENTRIES = 100_000;
const MAX_ENTRY_DEPTH = 64;
const MAX_ENTRY_PATH_BYTES = 4096;
// Extraction always leaves at least this much free space on the disk.
const EXTRACT_DISK_RESERVE = 512 * 1024 * 1024;
const ON_LINUX = process.platform === "linux";
const openFd = promisify(fs.open);

export function isArchiveName(name: string) {
  return ARCHIVE_EXTENSION.test(name);
}

/** Splits "photos.tar.gz" into ["photos", ".tar.gz"]; non-archives split at their last extension. */
export function splitArchiveName(name: string): [string, string] {
  const match = ARCHIVE_EXTENSION.exec(name);
  if (match && match.index > 0) return [name.slice(0, match.index), match[0]];
  const extension = path.extname(name);
  return extension ? [name.slice(0, -extension.length), extension] : [name, ""];
}

function cancelled() {
  return new AppError("The job was cancelled", 409, "JOB_CANCELLED");
}

/** True for opened paths inside FilesDude's internal folders or the state directory. */
export async function reservedPathCheck() {
  const stateDirectory = await fsp.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
  return (opened: string) => opened.split(path.sep).some((part) => INTERNAL_NAMES.has(part))
    || opened === stateDirectory || opened.startsWith(`${stateDirectory}${path.sep}`);
}

// A directory held open, so names inside it resolve against the directory itself even if its path
// is later renamed or replaced. `base` is a path prefix for that: the descriptor's /proc entry on
// Linux, or the real path elsewhere (development only).
type AnchoredDirectory = { handle: FileHandle; base: string; real: string; stat: Stats };

async function openDirectory(location: string, expected: string, isReserved: (opened: string) => boolean): Promise<AnchoredDirectory> {
  const handle = await fsp.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, expected);
    if (isReserved(openedPath)) throw new AppError("That folder is reserved by FilesDude", 403, "RESERVED_PATH");
    return { handle, base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : openedPath, real: openedPath, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function inside(directory: AnchoredDirectory, ...names: string[]) {
  return path.join(directory.base, ...names);
}

// New output takes the owner of the folder it is created in rather than root, matching what that
// folder's users can work with. Only applies when the service runs as root.
function ownerFor(directory: AnchoredDirectory) {
  return typeof process.getuid === "function" && process.getuid() === 0 ? { uid: directory.stat.uid, gid: directory.stat.gid } : null;
}

// Removes `name` from `directory` only if it is still the same file that was created there.
async function removeIfSame(directory: AnchoredDirectory, name: string, created: Stats, remove: (location: string) => Promise<void>) {
  const current = await fsp.lstat(inside(directory, name)).catch(() => null);
  if (current && current.ino === created.ino && current.dev === created.dev) await remove(inside(directory, name)).catch(() => undefined);
}

export function appendFileAndWait(archive: Archiver, stream: Readable, name: string, stats: Stats, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off("error", onError);
      stream.off("error", onError);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); stream.destroy(); reject(cancelled()); };
    if (signal?.aborted) return onAbort();
    archive.once("error", onError);
    stream.once("error", onError);
    stream.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      archive.append(stream, { name, stats });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Adds a directory's contents to an archive without following symlinks (links are stored as links),
 * verifying every opened entry is inside the root and leaving out anything `skip` matches.
 * Children are opened relative to the directory's own descriptor. Takes ownership of `handle`.
 */
export async function appendDirectory(archive: Archiver, handle: FileHandle, openedPath: string, archivePath: string, skip: (openedPath: string) => boolean, signal?: AbortSignal, storeLinks = true) {
  const directoryPath = ON_LINUX ? `/proc/self/fd/${handle.fd}` : openedPath;
  let directory;
  try {
    directory = await fsp.opendir(directoryPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  try {
    for await (const entry of directory) {
      if (signal?.aborted) throw cancelled();
      if (INTERNAL_NAMES.has(entry.name)) continue;
      const childPath = path.join(directoryPath, entry.name);
      const childArchivePath = path.posix.join(archivePath, entry.name);

      if (entry.isSymbolicLink()) {
        if (!storeLinks) continue;
        try {
          archive.symlink(childArchivePath, await fsp.readlink(childPath));
        } catch {
          // The entry changed while the archive was being created; omit it.
        }
        continue;
      }

      // O_NONBLOCK keeps a FIFO from blocking the open; anything not a file or folder is skipped below.
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0);
      let childHandle: FileHandle | null = null;
      try {
        childHandle = await fsp.open(childPath, flags);
      } catch {
        continue;
      }

      try {
        const verified = await verifyFileHandleWithinRoot(childHandle, path.join(openedPath, entry.name));
        if (skip(verified.openedPath)) continue;
        if (verified.stat.isDirectory()) {
          archive.append(Buffer.alloc(0), { name: `${childArchivePath}/`, type: "directory", stats: verified.stat });
          const nested = childHandle;
          childHandle = null;
          await appendDirectory(archive, nested, verified.openedPath, childArchivePath, skip, signal, storeLinks);
        } else if (verified.stat.isFile()) {
          const stream = childHandle.createReadStream();
          childHandle = null;
          await appendFileAndWait(archive, stream, childArchivePath, verified.stat, signal);
        }
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

// Sizes a directory's contents through its descriptor, for progress reporting only.
async function measureOpened(handle: FileHandle, openedPath: string) {
  const base = ON_LINUX ? `/proc/self/fd/${handle.fd}` : openedPath;
  let bytes = 0;
  let complete = true;
  for (const name of await fsp.readdir(base).catch(() => null) ?? []) {
    const measured = await measureTree(path.join(base, name));
    bytes += measured.bytes;
    complete &&= measured.complete;
  }
  return { bytes, complete };
}

type CompressSource = { name: string; link?: string; handle?: FileHandle; opened?: string; stat?: Stats };

/** Archives `paths` into a new file in `destinationPath` named after `requestedName`. */
export async function compressEntries(paths: string[], destinationPath: string, requestedName: string, format: ArchiveFormat, report: ProgressReporter, signal: AbortSignal): Promise<ArchiveResult> {
  if (!paths.length) throw new AppError("Choose at least one item to compress", 400);
  if (format !== "zip" && format !== "tar.gz") throw new AppError("Choose zip or tar.gz", 400, "INVALID_FORMAT");
  const extension = format === "zip" ? ".zip" : ".tar.gz";
  const [stem] = splitArchiveName(validateName(requestedName));
  if (!stem) throw new AppError("Enter a name for the archive", 400, "INVALID_NAME");
  const isReserved = await reservedPathCheck();

  // Everything is opened by handle under the lock; the slow archiving then never re-resolves a path.
  const release = await acquireFilesystemLock();
  const sources: CompressSource[] = [];
  let destination: AnchoredDirectory | null = null;
  let output: { handle: FileHandle; name: string; stat: Stats; real: string };
  try {
    const root = await ensureRoot();
    const destinationAbsolute = await safeResolve(destinationPath);
    destination = await openDirectory(destinationAbsolute, destinationAbsolute, isReserved);
    for (const sourcePath of paths) {
      const absolute = await safeResolve(sourcePath, { followSymlink: false });
      if (absolute === root) throw new AppError("The root folder cannot be compressed", 400);
      const name = path.basename(absolute);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        sources.push({ name, link: await fsp.readlink(absolute) });
        continue;
      }
      const handle = await fsp.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
      sources.push({ name, handle });
      const verified = await verifyFileHandleWithinRoot(handle, absolute);
      if (isReserved(verified.openedPath)) throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
      Object.assign(sources.at(-1)!, { opened: verified.openedPath, stat: verified.stat });
    }
    output = await reserveFile(destination, stem, extension);
  } catch (error) {
    await Promise.all(sources.map((source) => source.handle?.close().catch(() => undefined)));
    await destination?.handle.close().catch(() => undefined);
    throw error;
  } finally {
    release();
  }

  const archive = format === "zip" ? new ZipArchive({ zlib: { level: 6 } }) : new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
  let bytesWritten = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      callback(null, chunk);
    },
  });
  const owner = ownerFor(destination);
  // abort() stops archiver but does not end its output, so the stream is also destroyed;
  // otherwise waiting for the output to finish would hang forever.
  const stop = () => {
    archive.abort();
    archive.destroy();
  };
  signal.addEventListener("abort", stop, { once: true });
  let written: Promise<void> | null = null;
  try {
    if (owner) await output.handle.chown(owner.uid, owner.gid);
    // The write stream owns the output handle from here and closes it when finished.
    written = pipeline(archive, meter, output.handle.createWriteStream());
    written.catch(() => undefined);

    let total = 0;
    let complete = true;
    for (const source of sources) {
      if (!source.handle || !source.stat) continue;
      const measured = source.stat.isDirectory() ? await measureOpened(source.handle, source.opened!) : { bytes: source.stat.size, complete: true };
      total += measured.bytes;
      complete &&= measured.complete;
    }
    let entries = 0;
    archive.on("progress", (data) => {
      entries = data.entries.processed;
      report({ done: data.fs.processedBytes, total: complete ? total : undefined, unit: "bytes" });
    });

    // Never add the archive being written, even when it sits inside a folder being compressed.
    const skip = (opened: string) => opened === output.real || isReserved(opened);
    for (const source of sources) {
      if (signal.aborted) throw cancelled();
      if (source.link !== undefined) {
        archive.symlink(source.name, source.link);
        continue;
      }
      const handle = source.handle!;
      source.handle = undefined;
      if (source.stat!.isDirectory()) {
        archive.append(Buffer.alloc(0), { name: `${source.name}/`, type: "directory", stats: source.stat });
        await appendDirectory(archive, handle, source.opened!, source.name, skip, signal);
      } else if (source.stat!.isFile()) {
        await appendFileAndWait(archive, handle.createReadStream(), source.name, source.stat!, signal);
      } else {
        await handle.close().catch(() => undefined);
      }
    }
    if (signal.aborted) throw cancelled();
    await archive.finalize();
    await written;
    if (signal.aborted) throw cancelled();
    return { path: relativeFromAbsolute(path.join(destination.real, output.name)), entries, bytes: bytesWritten, skipped: 0 };
  } catch (error) {
    stop();
    if (written) await written.catch(() => undefined);
    else await output.handle.close().catch(() => undefined);
    await removeIfSame(destination, output.name, output.stat, (location) => fsp.unlink(location));
    throw signal.aborted ? cancelled() : error;
  } finally {
    signal.removeEventListener("abort", stop);
    await Promise.all(sources.map((source) => source.handle?.close().catch(() => undefined)));
    await destination.handle.close().catch(() => undefined);
  }
}

// Creates "stem.ext", then "stem (2).ext", ... exclusively inside the open destination folder.
async function reserveFile(directory: AnchoredDirectory, stem: string, extension: string) {
  for (let index = 1; index < 1_000; index += 1) {
    const name = validateName(index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`);
    let handle: FileHandle;
    try {
      handle = await fsp.open(inside(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const stat = await handle.stat();
    try {
      const { openedPath } = await verifyFileHandleWithinRoot(handle, path.join(directory.real, name));
      return { handle, name, stat, real: openedPath };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await removeIfSame(directory, name, stat, (location) => fsp.unlink(location));
      throw error;
    }
  }
  throw new AppError(`Unable to choose an available name for ${stem}${extension}`, 409, "NAME_CONFLICT");
}

// Creates a new folder that only the service can enter until extraction finishes, and confirms
// the folder opened is the one just created rather than something swapped in under its name.
async function createPrivateFolder(parent: AnchoredDirectory, stem: string, isReserved: (opened: string) => boolean) {
  for (let index = 1; index < 1_000; index += 1) {
    const name = validateName(index === 1 ? stem : `${stem} (${index})`);
    try {
      await fsp.mkdir(inside(parent, name), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const folder = await openDirectory(inside(parent, name), path.join(parent.real, name), isReserved);
    const ownUid = typeof process.getuid === "function" ? process.getuid() : folder.stat.uid;
    if (folder.stat.uid !== ownUid || (folder.stat.mode & 0o777) !== 0o700 || (await fsp.readdir(folder.base)).length) {
      await folder.handle.close().catch(() => undefined);
      throw new AppError("The extraction folder was changed while it was being created", 409, "EXTRACTION_CONFLICT");
    }
    return { folder, name };
  }
  throw new AppError(`Unable to choose an available folder name for ${stem}`, 409, "NAME_CONFLICT");
}

function unsafeEntry(name: string) {
  const shown = name.length > 80 ? `${name.slice(0, 77)}...` : name;
  return new AppError(`This archive contains an unsafe path ("${shown}") and was not extracted`, 422, "UNSAFE_ARCHIVE");
}

/**
 * The relative path an archive entry may be written to, or null for entries naming the archive root
 * itself (such as "./"). Throws for absolute paths, ".." segments, and FilesDude's reserved names,
 * because an archive containing them is treated as hostile and not extracted at all.
 */
export function safeEntryPath(raw: string) {
  const name = raw.replaceAll("\\", "/");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw unsafeEntry(raw);
  const parts = name.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".." || INTERNAL_NAMES.has(part) || Buffer.byteLength(part, "utf8") > 255)) throw unsafeEntry(raw);
  if (parts.length > MAX_ENTRY_DEPTH || Buffer.byteLength(parts.join("/"), "utf8") > MAX_ENTRY_PATH_BYTES) {
    throw new AppError(`This archive nests folders more deeply than FilesDude will extract (${MAX_ENTRY_DEPTH} levels)`, 422, "ARCHIVE_TOO_DEEP");
  }
  return parts.length ? parts.join("/") : null;
}

// Writes extracted entries inside the private folder. Links, devices, and other special entries
// are never created, so nothing extracted can point anywhere else.
class ExtractionTarget {
  entries = 0;
  bytes = 0;
  skipped = 0;
  private readonly directories = new Set<string>();

  constructor(
    private readonly base: string,
    private readonly budget: number,
    private readonly maxEntries: number,
    private readonly signal: AbortSignal,
  ) {}

  private locate(raw: string) {
    if (this.signal.aborted) throw cancelled();
    const relative = safeEntryPath(raw);
    if (relative === null) return null;
    this.entries += 1;
    if (this.entries > this.maxEntries) throw new AppError(`This archive has more than ${this.maxEntries.toLocaleString()} entries, which is more than FilesDude will extract`, 413, "ARCHIVE_TOO_LARGE");
    return relative;
  }

  private async makeDirectories(relative: string) {
    const parts = relative ? relative.split("/") : [];
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      if (this.directories.has(prefix)) continue;
      try {
        await fsp.mkdir(path.join(this.base, prefix), { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await fsp.lstat(path.join(this.base, prefix))).isDirectory()) throw new AppError("This archive has a file and a folder with the same name", 422, "ARCHIVE_CONFLICT");
      }
      this.directories.add(prefix);
    }
  }

  async directory(raw: string) {
    const relative = this.locate(raw);
    if (relative) await this.makeDirectories(relative);
  }

  async file(raw: string, stream: Readable) {
    const relative = this.locate(raw);
    if (!relative) {
      stream.resume();
      return;
    }
    await this.makeDirectories(path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
    let handle: FileHandle;
    try {
      handle = await fsp.open(path.join(this.base, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A repeated name keeps the first copy.
      this.skipped += 1;
      stream.resume();
      return;
    }
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.bytes += chunk.length;
        if (this.bytes > this.budget) callback(new AppError("Extracting this archive would fill the disk, so it was stopped", 507, "INSUFFICIENT_STORAGE"));
        else callback(null, chunk);
      },
    });
    // The write stream owns the handle and closes it when finished.
    await pipeline(stream, meter, handle.createWriteStream(), { signal: this.signal });
  }

  skip(raw: string) {
    if (this.locate(raw)) this.skipped += 1;
  }
}

// Applies normal permissions and the destination's owner, children before their folder, so every
// folder is still private to the service while its contents are being handed over.
async function handOver(directory: string, owner: { uid: number; gid: number } | null) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await handOver(location, owner);
      await fsp.chmod(location, 0o750);
    } else if (entry.isFile()) {
      await fsp.chmod(location, 0o640);
    } else {
      continue;
    }
    if (owner) await fsp.lchown(location, owner.uid, owner.gid);
  }
}

// Archive-format problems are explained to the user; filesystem errors are logged instead, since
// their messages can include absolute paths on the server.
function extractionFailure(error: unknown, label: string) {
  if (error instanceof AppError || (error as Error).name === "AbortError") return error;
  if ((error as NodeJS.ErrnoException).syscall || (error as NodeJS.ErrnoException).path) {
    console.error(error);
    return new AppError(`${label} couldn't be extracted because of a storage error`, 500, "EXTRACTION_FAILED");
  }
  return new AppError(`${label} can't be extracted (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
}

async function extractZip(archive: { handle: FileHandle; real: string }, target: ExtractionTarget, report: ProgressReporter) {
  // yauzl gets its own descriptor for the same file and closes it itself (zip.close()), so it can
  // never read through a descriptor number that has been closed and reused.
  const fd = await openFd(ON_LINUX ? `/proc/self/fd/${archive.handle.fd}` : archive.real, "r");
  let zip: yauzl.ZipFile;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromFd(fd, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, file) => (error || !file ? reject(error ?? new Error("Unreadable zip file")) : resolve(file)));
    });
  } catch (error) {
    fs.close(fd, () => undefined);
    throw extractionFailure(error, "This zip file");
  }
  const total = zip.entryCount;
  let processed = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const type = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (entry.fileName.endsWith("/")) {
            await target.directory(entry.fileName);
          } else if (type !== 0 && type !== 0o100000) {
            // Symlinks and other special entries are never created.
            target.skip(entry.fileName);
          } else {
            if (entry.isEncrypted()) throw new AppError("Encrypted zip files can't be extracted", 422, "ENCRYPTED_ARCHIVE");
            const stream = await new Promise<Readable>((open, fail) => zip.openReadStream(entry, (error, readable) => (error || !readable ? fail(error) : open(readable))));
            await target.file(entry.fileName, stream);
          }
          processed += 1;
          report({ done: processed, total, unit: "entries" });
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } catch (error) {
    zip.close();
    throw extractionFailure(error, "This zip file");
  }
}

async function extractTar(handle: FileHandle, gzip: boolean, size: number, target: ExtractionTarget, report: ProgressReporter, signal: AbortSignal) {
  let read = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      read += chunk.length;
      callback(null, chunk);
    },
  });
  const extract = tarStream.extract();
  extract.on("entry", (header, stream, next) => {
    void (async () => {
      if (header.type === "directory") {
        await target.directory(header.name);
        stream.resume();
      } else if (header.type === "file" || header.type === "contiguous-file") {
        await target.file(header.name, stream);
      } else {
        // Symlinks, hard links, devices, and FIFOs are never created.
        target.skip(header.name);
        stream.resume();
      }
      report({ done: read, total: size, unit: "bytes" });
    })().then(() => next(), (error: Error) => next(error));
  });
  try {
    // The read stream owns the handle and closes it when finished.
    const source = handle.createReadStream();
    await (gzip
      ? pipeline(source, counter, zlib.createGunzip(), extract, { signal })
      : pipeline(source, counter, extract, { signal }));
  } catch (error) {
    throw extractionFailure(error, "This archive");
  }
}

async function detectFormat(handle: FileHandle, name: string): Promise<"zip" | "tar" | "tar.gz"> {
  const header = Buffer.alloc(265);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead >= 4 && header[0] === 0x50 && header[1] === 0x4b && (header[2] === 3 || header[2] === 5)) return "zip";
  if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) return "tar.gz";
  if (bytesRead >= 262 && header.toString("latin1", 257, 262) === "ustar") return "tar";
  if (/\.tar$/i.test(name) && bytesRead >= 512) return "tar";
  throw new AppError("Only .zip, .tar, .tar.gz, and .tgz archives can be extracted", 415, "UNSUPPORTED_ARCHIVE");
}

/**
 * Extracts an archive into a new folder beside it, named after the archive. Any unsafe entry
 * stops the whole extraction and removes the partial folder.
 */
export async function extractArchive(archivePath: string, report: ProgressReporter, signal: AbortSignal, limits: { maxEntries?: number; reserveBytes?: number } = {}): Promise<ArchiveResult> {
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  let source: { handle: FileHandle; real: string };
  let parent: AnchoredDirectory;
  let folder: AnchoredDirectory;
  let folderName: string;
  let size: number;
  let format: Awaited<ReturnType<typeof detectFormat>>;
  try {
    const opened = await openVerifiedFile(archivePath);
    source = { handle: opened.handle, real: opened.openedPath };
    let openedParent: AnchoredDirectory | null = null;
    try {
      if (!opened.stat.isFile()) throw new AppError("Only files can be extracted", 400, "NOT_A_FILE");
      if (isReserved(opened.openedPath)) throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
      size = opened.stat.size;
      format = await detectFormat(source.handle, opened.absolute);
      const parentPath = path.dirname(opened.openedPath);
      openedParent = await openDirectory(parentPath, parentPath, isReserved);
      const [stem] = splitArchiveName(path.basename(opened.absolute));
      ({ folder, name: folderName } = await createPrivateFolder(openedParent, stem || "Extracted", isReserved));
      parent = openedParent;
    } catch (error) {
      await openedParent?.handle.close().catch(() => undefined);
      await source.handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    release();
  }

  let succeeded = false;
  try {
    const disk = await fsp.statfs(folder.base);
    const budget = Number(disk.bavail) * Number(disk.bsize) - (limits.reserveBytes ?? EXTRACT_DISK_RESERVE);
    if (budget <= 0) throw new AppError("There isn't enough free space on this disk to extract anything", 507, "INSUFFICIENT_STORAGE");
    const target = new ExtractionTarget(folder.base, budget, limits.maxEntries ?? MAX_EXTRACT_ENTRIES, signal);
    report({ done: 0, total: format === "zip" ? undefined : size, unit: format === "zip" ? "entries" : "bytes" });
    if (format === "zip") await extractZip(source, target, report);
    else await extractTar(source.handle, format === "tar.gz", size, target, report, signal);
    if (signal.aborted) throw cancelled();

    const owner = ownerFor(parent);
    await handOver(folder.base, owner);
    if (owner) await folder.handle.chown(owner.uid, owner.gid);
    await folder.handle.chmod(0o750);
    succeeded = true;
    return { path: relativeFromAbsolute(path.join(parent.real, folderName)), entries: target.entries, bytes: target.bytes, skipped: target.skipped };
  } catch (error) {
    throw signal.aborted ? cancelled() : error;
  } finally {
    if (!succeeded) {
      // Everything below the private folder was created by this job and nobody else can write
      // there, so it can be removed by path; the folder itself only if its name still refers to it.
      for (const name of await fsp.readdir(folder.base).catch(() => [] as string[])) {
        await fsp.rm(path.join(folder.base, name), { recursive: true, force: true }).catch(() => undefined);
      }
      await removeIfSame(parent, folderName, folder.stat, (location) => fsp.rmdir(location));
    }
    await source.handle.close().catch(() => undefined);
    await folder.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
}
