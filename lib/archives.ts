import { constants, type Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { TarArchive, ZipArchive, type Archiver } from "archiver";
import tarStream from "tar-stream";
import yauzl from "yauzl";
import { config } from "./config";
import { AppError } from "./http";
import { acquireFilesystemLock, ensureRoot, INTERNAL_NAMES, measureTree, openVerifiedFile, relativeFromAbsolute, safeResolve, validateName, verifyFileHandleWithinRoot } from "./files";
import type { ArchiveFormat, ArchiveResult, JobProgress } from "./types";

export type ProgressReporter = (progress: JobProgress) => void;

const ARCHIVE_EXTENSION = /\.(zip|tar\.gz|tgz|tar)$/i;
const MAX_EXTRACT_ENTRIES = 100_000;
// Extraction always leaves at least this much free space on the disk.
const EXTRACT_DISK_RESERVE = 512 * 1024 * 1024;

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

// The service often runs as root; new files take the owner of the folder they are created in
// rather than root, matching what that folder's users can work with.
async function folderOwner(directory: string) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const stat = await fsp.stat(directory);
  return { uid: stat.uid, gid: stat.gid };
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
 * Takes ownership of `handle` and closes it.
 */
export async function appendDirectory(archive: Archiver, handle: FileHandle, openedPath: string, archivePath: string, skip: (openedPath: string) => boolean, signal?: AbortSignal) {
  const directoryPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : openedPath;
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
        try {
          archive.symlink(childArchivePath, await fsp.readlink(childPath));
        } catch {
          // The entry changed while the archive was being created; omit it.
        }
        continue;
      }

      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (entry.isDirectory() ? constants.O_DIRECTORY : 0);
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
          await appendDirectory(archive, nested, verified.openedPath, childArchivePath, skip, signal);
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

async function stateDirectorySkipper() {
  const stateDirectory = await fsp.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
  return (opened: string) => opened === stateDirectory || opened.startsWith(`${stateDirectory}${path.sep}`);
}

// Reserves "stem.ext", then "stem (2).ext", ... by creating it exclusively.
async function reserveFile(directoryRelative: string, stem: string, extension: string) {
  for (let index = 1; index < 1_000; index += 1) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
    const target = await safeResolve([directoryRelative, name].filter(Boolean).join("/"), { mustExist: false, followSymlink: false });
    let handle: FileHandle;
    try {
      handle = await fsp.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await verifyFileHandleWithinRoot(handle, target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(target, { force: true });
      throw error;
    }
    return { target, handle };
  }
  throw new AppError(`Unable to choose an available name for ${stem}${extension}`, 409, "NAME_CONFLICT");
}

async function reserveDirectory(directoryRelative: string, stem: string) {
  for (let index = 1; index < 1_000; index += 1) {
    const name = index === 1 ? stem : `${stem} (${index})`;
    const target = await safeResolve([directoryRelative, name].filter(Boolean).join("/"), { mustExist: false, followSymlink: false });
    try {
      await fsp.mkdir(target, { mode: 0o750 });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new AppError(`Unable to choose an available folder name for ${stem}`, 409, "NAME_CONFLICT");
}

/** Archives `paths` into a new file in `destinationPath` named after `requestedName`. */
export async function compressEntries(paths: string[], destinationPath: string, requestedName: string, format: ArchiveFormat, report: ProgressReporter, signal: AbortSignal): Promise<ArchiveResult> {
  if (!paths.length) throw new AppError("Choose at least one item to compress", 400);
  if (format !== "zip" && format !== "tar.gz") throw new AppError("Choose zip or tar.gz", 400, "INVALID_FORMAT");
  const extension = format === "zip" ? ".zip" : ".tar.gz";
  const [stem] = splitArchiveName(validateName(requestedName));
  if (!stem) throw new AppError("Enter a name for the archive", 400, "INVALID_NAME");

  // Paths are resolved and the output reserved under the lock; the slow archiving runs without it.
  const release = await acquireFilesystemLock();
  const root = await ensureRoot();
  const sources: Array<{ absolute: string; name: string }> = [];
  let target: string;
  let handle: FileHandle;
  let owner: Awaited<ReturnType<typeof folderOwner>>;
  try {
    const destination = await safeResolve(destinationPath);
    if (!(await fsp.stat(destination)).isDirectory()) throw new AppError("The destination is not a folder", 400);
    for (const sourcePath of paths) {
      const absolute = await safeResolve(sourcePath, { followSymlink: false });
      if (absolute === root) throw new AppError("The root folder cannot be compressed", 400);
      sources.push({ absolute, name: path.basename(absolute) });
    }
    owner = await folderOwner(destination);
    ({ target, handle } = await reserveFile(relativeFromAbsolute(destination), stem, extension));
  } finally {
    release();
  }

  const archive = format === "zip" ? new ZipArchive({ zlib: { level: 6 } }) : new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
  // The write stream owns the handle and closes it when finished.
  const written = pipeline(archive, handle.createWriteStream());
  written.catch(() => undefined);
  // abort() stops archiver but does not end its output, so the stream is also destroyed;
  // otherwise waiting for the output to finish would hang forever.
  const stop = () => {
    archive.abort();
    archive.destroy();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    let total = 0;
    let complete = true;
    for (const source of sources) {
      const stat = await fsp.lstat(source.absolute);
      const measured = stat.isDirectory() ? await measureTree(source.absolute) : { bytes: stat.isFile() ? stat.size : 0, complete: true };
      total += measured.bytes;
      complete &&= measured.complete;
    }
    let entries = 0;
    archive.on("progress", (data) => {
      entries = data.entries.processed;
      report({ done: data.fs.processedBytes, total: complete ? total : undefined, unit: "bytes" });
    });

    const targetReal = await fsp.realpath(target);
    const skipState = await stateDirectorySkipper();
    // Never add the archive being written, even when it sits inside a folder being compressed.
    const skip = (opened: string) => opened === targetReal || skipState(opened);
    for (const source of sources) {
      if (signal.aborted) throw cancelled();
      const stat = await fsp.lstat(source.absolute);
      if (stat.isSymbolicLink()) {
        archive.symlink(source.name, await fsp.readlink(source.absolute));
        continue;
      }
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : 0);
      const sourceHandle = await fsp.open(source.absolute, flags);
      let owned: FileHandle | null = sourceHandle;
      try {
        const verified = await verifyFileHandleWithinRoot(sourceHandle, source.absolute);
        if (skip(verified.openedPath)) continue;
        if (verified.stat.isDirectory()) {
          archive.append(Buffer.alloc(0), { name: `${source.name}/`, type: "directory", stats: verified.stat });
          owned = null;
          await appendDirectory(archive, sourceHandle, verified.openedPath, source.name, skip, signal);
        } else if (verified.stat.isFile()) {
          const stream = sourceHandle.createReadStream();
          owned = null;
          await appendFileAndWait(archive, stream, source.name, verified.stat, signal);
        }
      } finally {
        await owned?.close().catch(() => undefined);
      }
    }
    if (signal.aborted) throw cancelled();
    await archive.finalize();
    await written;
    if (signal.aborted) throw cancelled();
    if (owner) await fsp.lchown(target, owner.uid, owner.gid);
    return { path: relativeFromAbsolute(target), entries, bytes: (await fsp.stat(target)).size, skipped: 0 };
  } catch (error) {
    stop();
    await written.catch(() => undefined);
    await fsp.rm(target, { force: true });
    throw signal.aborted ? cancelled() : error;
  } finally {
    signal.removeEventListener("abort", stop);
  }
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
  return parts.length ? parts.join("/") : null;
}

// Writes extracted entries strictly inside a freshly created folder. Links, devices, and other
// special entries are never created, so nothing extracted can point outside that folder.
class ExtractionTarget {
  entries = 0;
  bytes = 0;
  skipped = 0;

  constructor(
    private readonly folder: string,
    private readonly budget: number,
    private readonly maxEntries: number,
    private readonly owner: { uid: number; gid: number } | null,
    private readonly signal: AbortSignal,
  ) {}

  private locate(raw: string) {
    if (this.signal.aborted) throw cancelled();
    const relative = safeEntryPath(raw);
    if (relative === null) return null;
    this.entries += 1;
    if (this.entries > this.maxEntries) throw new AppError(`This archive has more than ${this.maxEntries.toLocaleString()} entries, which is more than FilesDude will extract`, 413, "ARCHIVE_TOO_LARGE");
    const absolute = path.join(this.folder, ...relative.split("/"));
    if (!absolute.startsWith(`${this.folder}${path.sep}`)) throw unsafeEntry(raw);
    return absolute;
  }

  private async makeDirectories(directory: string) {
    if (directory === this.folder) return;
    await this.makeDirectories(path.dirname(directory));
    try {
      await fsp.mkdir(directory, { mode: 0o750 });
      if (this.owner) await fsp.lchown(directory, this.owner.uid, this.owner.gid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Only a real directory created by this extraction may be reused.
      if (!(await fsp.lstat(directory)).isDirectory()) throw new AppError("This archive has a file and a folder with the same name", 422, "ARCHIVE_CONFLICT");
    }
  }

  async directory(raw: string) {
    const absolute = this.locate(raw);
    if (absolute) await this.makeDirectories(absolute);
  }

  async file(raw: string, stream: Readable) {
    const absolute = this.locate(raw);
    if (!absolute) {
      stream.resume();
      return;
    }
    await this.makeDirectories(path.dirname(absolute));
    let handle: FileHandle;
    try {
      handle = await fsp.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A repeated name keeps the first copy.
      this.skipped += 1;
      stream.resume();
      return;
    }
    try {
      await verifyFileHandleWithinRoot(handle, absolute);
      if (this.owner) await handle.chown(this.owner.uid, this.owner.gid);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.bytes += chunk.length;
        if (this.bytes > this.budget) callback(new AppError("Extracting this archive would fill the disk, so it was stopped", 507, "INSUFFICIENT_STORAGE"));
        else callback(null, chunk);
      },
    });
    await pipeline(stream, meter, handle.createWriteStream(), { signal: this.signal });
  }

  skip(raw: string) {
    if (this.locate(raw)) this.skipped += 1;
  }
}

async function extractZip(fd: number, target: ExtractionTarget, report: ProgressReporter) {
  // yauzl closes the descriptor only via zip.close(), which is never called: the FileHandle that
  // owns the descriptor closes it once everything has finished.
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromFd(fd, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, file) => (error || !file ? reject(error ?? new Error("Unreadable zip file")) : resolve(file)));
  }).catch((error) => {
    if (error instanceof AppError) throw error;
    throw new AppError(`This zip file can't be read (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
  });
  const total = zip.entryCount;
  let processed = 0;
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
  }).catch((error) => {
    if (error instanceof AppError || (error as Error).name === "AbortError") throw error;
    throw new AppError(`This zip file can't be extracted (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
  });
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
    if (error instanceof AppError || (error as Error).name === "AbortError") throw error;
    throw new AppError(`This archive can't be extracted (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
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
  const release = await acquireFilesystemLock();
  let handle: FileHandle;
  let size: number;
  let format: Awaited<ReturnType<typeof detectFormat>>;
  let folder: string;
  let owner: Awaited<ReturnType<typeof folderOwner>>;
  try {
    const opened = await openVerifiedFile(archivePath);
    handle = opened.handle;
    try {
      if (!opened.stat.isFile()) throw new AppError("Only files can be extracted", 400, "NOT_A_FILE");
      size = opened.stat.size;
      format = await detectFormat(handle, opened.absolute);
      const parent = path.dirname(opened.absolute);
      owner = await folderOwner(parent);
      const [stem] = splitArchiveName(path.basename(opened.absolute));
      folder = await reserveDirectory(relativeFromAbsolute(parent), stem || "Extracted");
      if (owner) await fsp.lchown(folder, owner.uid, owner.gid);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    release();
  }

  try {
    const disk = await fsp.statfs(folder);
    const budget = Number(disk.bavail) * Number(disk.bsize) - (limits.reserveBytes ?? EXTRACT_DISK_RESERVE);
    if (budget <= 0) throw new AppError("There isn't enough free space on this disk to extract anything", 507, "INSUFFICIENT_STORAGE");
    const target = new ExtractionTarget(folder, budget, limits.maxEntries ?? MAX_EXTRACT_ENTRIES, owner, signal);
    report({ done: 0, total: format === "zip" ? undefined : size, unit: format === "zip" ? "entries" : "bytes" });
    if (format === "zip") await extractZip(handle.fd, target, report);
    else await extractTar(handle, format === "tar.gz", size, target, report, signal);
    if (signal.aborted) throw cancelled();
    return { path: relativeFromAbsolute(folder), entries: target.entries, bytes: target.bytes, skipped: target.skipped };
  } catch (error) {
    await fsp.rm(folder, { recursive: true, force: true });
    throw signal.aborted ? cancelled() : error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
