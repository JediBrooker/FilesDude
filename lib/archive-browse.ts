import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import tarStream from "tar-stream";
import yauzl from "yauzl";
import { detectFormat, reservedPathCheck, zipName } from "./archives";
import { acquireFilesystemLock, INTERNAL_NAMES, openVerifiedFile } from "./files";
import { AppError } from "./http";

// Looks inside .zip, .tar, .tar.gz, and .tgz archives without extracting them: what each folder of
// an archive holds, and one file's contents (to preview or download). Nothing is written to disk.
// A zip's catalog is read from its central directory; a tar has to be read through, so its catalog
// is kept (by the archive's identity) while browsing. Entries with unsafe names (absolute, "..",
// FilesDude's own folder) are counted but never listed or read.

export type ArchiveItemType = "file" | "directory" | "link" | "other";

export type ArchiveItem = {
  name: string;
  /** Where the item is inside the archive. */
  path: string;
  type: ArchiveItemType;
  size: number;
  modified: string | null;
  encrypted?: boolean;
  /** For folders: how many items are directly inside. */
  items?: number;
};

export type ArchiveListing = {
  archive: string;
  format: "zip" | "tar" | "tar.gz";
  /** The folder of the archive listed ("" for its top). */
  folder: string;
  items: ArchiveItem[];
  /** Every entry in the archive (listed or not), and those left out as unsafe. */
  entries: number;
  unsafe: number;
  /** Reading the archive stopped short (too many entries, or it took too long). */
  truncated: boolean;
};

type Entry = { type: ArchiveItemType; size: number; modified: string | null; encrypted?: boolean };
type Catalog = { format: ArchiveListing["format"]; entries: Map<string, Entry>; children: Map<string, Set<string>>; total: number; unsafe: number; truncated: boolean };

const MAX_ENTRIES = 100_000;
const READ_MS = 30_000;
const MAX_CACHED = 12;
const MAX_LISTED = 5_000;
const ON_LINUX = process.platform === "linux";
const openFd = promisify(fs.open);

const catalogs = new Map<string, Catalog>();
const reading = new Map<string, Promise<Catalog>>();

/** An entry's path inside the archive, or null for an unsafe one. Folders keep no trailing slash. */
export function entryPath(raw: string) {
  const name = raw.replaceAll("\\", "/");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || INTERNAL_NAMES.has(part) || Buffer.byteLength(part, "utf8") > 255)) return null;
  return parts.join("/");
}

class CatalogBuilder {
  readonly entries = new Map<string, Entry>();
  readonly children = new Map<string, Set<string>>([["", new Set()]]);
  total = 0;
  unsafe = 0;
  truncated = false;
  private readonly startedAt = Date.now();

  /** Adds an entry; false once reading should stop. */
  add(raw: string, entry: Entry) {
    this.total += 1;
    if (this.total > MAX_ENTRIES || Date.now() - this.startedAt > READ_MS) {
      this.truncated = true;
      return false;
    }
    const relative = entryPath(raw);
    if (!relative) {
      this.unsafe += 1;
      return true;
    }
    const parts = relative.split("/");
    // Folders that only appear in their contents' paths are listed too.
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join("/");
      this.link(folder);
      const existing = this.entries.get(folder);
      if (!existing) this.entries.set(folder, { type: "directory", size: 0, modified: null });
      else if (existing.type !== "directory") existing.type = "directory";
    }
    this.link(relative);
    const existing = this.entries.get(relative);
    // A folder seen first through its contents takes its own entry's date; a repeated file keeps the first.
    if (!existing || (existing.type === "directory" && entry.type === "directory")) this.entries.set(relative, entry);
    return true;
  }

  private link(relative: string) {
    const parent = path.posix.dirname(relative);
    const key = parent === "." ? "" : parent;
    let set = this.children.get(key);
    if (!set) this.children.set(key, (set = new Set()));
    set.add(relative);
  }
}

const modifiedOf = (date: Date | undefined) => (date && !Number.isNaN(date.getTime()) ? date.toISOString() : null);

function zipType(entry: yauzl.Entry): ArchiveItemType {
  if (zipName(entry).endsWith("/")) return "directory";
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type === 0o120000) return "link";
  return type === 0 || type === 0o100000 ? "file" : type === 0o040000 ? "directory" : "other";
}

function tarType(type: string | null | undefined): ArchiveItemType {
  if (type === "directory") return "directory";
  if (type === "file" || type === "contiguous-file") return "file";
  return type === "symlink" || type === "link" ? "link" : "other";
}

// yauzl gets its own descriptor for the same file and closes it itself, so it can never read through
// a descriptor number that has been closed and reused.
async function openZip(handle: FileHandle, real: string) {
  const fd = await openFd(ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, "r");
  try {
    return await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromFd(fd, { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: false }, (error, file) => (error || !file ? reject(error ?? new Error("Unreadable zip file")) : resolve(file)));
    });
  } catch (error) {
    fs.close(fd, () => undefined);
    throw new AppError(`This zip file can't be read (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
  }
}

async function readZipCatalog(handle: FileHandle, real: string, builder: CatalogBuilder) {
  const zip = await openZip(handle, real);
  await new Promise<void>((resolve, reject) => {
    zip.on("error", (error: Error) => reject(new AppError(`This zip file can't be read (${error.message})`, 422, "INVALID_ARCHIVE")));
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      const type = zipType(entry);
      const more = builder.add(zipName(entry), { type, size: type === "file" ? entry.uncompressedSize : 0, modified: modifiedOf(entry.getLastModDate()), encrypted: entry.isEncrypted() || undefined });
      if (more) zip.readEntry();
      else resolve();
    });
    zip.readEntry();
  }).finally(() => zip.close());
}

/**
 * A tar's bytes (unzipped for .tar.gz), read through a descriptor of its own, opened now: the
 * archive's handle can then be closed without the read ever going through a reused number.
 */
async function tarStreams(handle: FileHandle, real: string, gzip: boolean): Promise<Readable[]> {
  const fd = await openFd(ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, "r");
  const file = fs.createReadStream("", { fd, autoClose: true });
  return gzip ? [file, zlib.createGunzip()] : [file];
}

async function readTarCatalog(handle: FileHandle, real: string, gzip: boolean, builder: CatalogBuilder) {
  const extract = tarStream.extract();
  const streams = await tarStreams(handle, real, gzip);
  const stop = new AbortController();
  extract.on("entry", (header, stream, next) => {
    const type = tarType(header.type);
    const more = builder.add(header.name, { type, size: type === "file" ? header.size ?? 0 : 0, modified: modifiedOf(header.mtime) });
    stream.on("end", () => (more ? next() : stop.abort()));
    stream.resume();
  });
  try {
    await pipeline([...streams, extract], { signal: stop.signal });
  } catch (error) {
    if (stop.signal.aborted) return;
    throw new AppError(`This archive can't be read (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
  }
}

type Opened = { handle: FileHandle; real: string; key: string; format: Catalog["format"] };

// Opens the archive (inside the account's folder, under the filesystem lock) and says what it is.
async function openArchive(archivePath: string): Promise<Opened> {
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  try {
    const opened = await openVerifiedFile(archivePath);
    try {
      if (!opened.stat.isFile()) throw new AppError("Only files can be opened as archives", 400, "NOT_A_FILE");
      if (isReserved(opened.openedPath)) throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
      const format = await detectFormat(opened.handle, opened.absolute).catch(() => {
        throw new AppError("Only .zip, .tar, .tar.gz, and .tgz archives can be opened", 415, "UNSUPPORTED_ARCHIVE");
      });
      const { dev, ino, size, mtimeMs } = opened.stat;
      return { handle: opened.handle, real: opened.openedPath, key: `${dev}:${ino}:${size}:${mtimeMs}`, format };
    } catch (error) {
      await opened.handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    release();
  }
}

async function catalogOf(opened: Opened) {
  const cached = catalogs.get(opened.key);
  if (cached) {
    // Most recently used last.
    catalogs.delete(opened.key);
    catalogs.set(opened.key, cached);
    return cached;
  }
  let pending = reading.get(opened.key);
  if (!pending) {
    pending = (async () => {
      const builder = new CatalogBuilder();
      if (opened.format === "zip") await readZipCatalog(opened.handle, opened.real, builder);
      else await readTarCatalog(opened.handle, opened.real, opened.format === "tar.gz", builder);
      const catalog: Catalog = { format: opened.format, entries: builder.entries, children: builder.children, total: builder.total, unsafe: builder.unsafe, truncated: builder.truncated };
      catalogs.set(opened.key, catalog);
      while (catalogs.size > MAX_CACHED) catalogs.delete(catalogs.keys().next().value!);
      return catalog;
    })().finally(() => reading.delete(opened.key));
    reading.set(opened.key, pending);
  }
  return pending;
}

/** What one folder of an archive holds. */
export async function listArchive(archivePath: string, folderPath = ""): Promise<ArchiveListing> {
  const folder = folderPath ? entryPath(folderPath) : "";
  if (folder === null) throw new AppError("That folder isn't in this archive", 404, "NOT_FOUND");
  const opened = await openArchive(archivePath);
  try {
    const catalog = await catalogOf(opened);
    if (folder && catalog.entries.get(folder)?.type !== "directory") throw new AppError("That folder isn't in this archive", 404, "NOT_FOUND");
    const names = [...(catalog.children.get(folder) ?? [])].slice(0, MAX_LISTED);
    const items = names.map((relative): ArchiveItem => {
      const entry = catalog.entries.get(relative)!;
      return { name: path.posix.basename(relative), path: relative, ...entry, items: entry.type === "directory" ? catalog.children.get(relative)?.size ?? 0 : undefined };
    }).sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { archive: archivePath, format: catalog.format, folder, items, entries: catalog.total, unsafe: catalog.unsafe, truncated: catalog.truncated || (catalog.children.get(folder)?.size ?? 0) > MAX_LISTED };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Ends `output` with an error if more than `limit` bytes come through (a zip that lies about a size). */
function capped(limit: number) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(new AppError("The file in the archive is larger than it says", 422, "INVALID_ARCHIVE"));
      else callback(null, chunk);
    },
  });
}

/**
 * One file inside an archive, as a stream of its contents (and its size, as the archive gives it).
 * The stream ends early, with an error, if the file turns out bigger than that.
 */
export async function readArchiveEntry(archivePath: string, entryName: string, signal?: AbortSignal): Promise<{ name: string; size: number; stream: Readable }> {
  const wanted = entryPath(entryName);
  if (!wanted) throw new AppError("That file isn't in this archive", 404, "NOT_FOUND");
  const opened = await openArchive(archivePath);
  try {
    const catalog = await catalogOf(opened);
    const entry = catalog.entries.get(wanted);
    if (!entry || entry.type !== "file") throw new AppError("That file isn't in this archive", 404, "NOT_FOUND");
    if (entry.encrypted) throw new AppError("That file is encrypted", 422, "ENCRYPTED_ARCHIVE");
    const output = new PassThrough();
    // Whoever reads it going away stops the reading.
    signal?.addEventListener("abort", () => output.destroy(), { once: true });
    const name = path.posix.basename(wanted);
    if (opened.format === "zip") {
      const zip = await openZip(opened.handle, opened.real);
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip.on("error", reject);
        zip.on("end", () => reject(new AppError("That file isn't in this archive", 404, "NOT_FOUND")));
        zip.on("entry", (item: yauzl.Entry) => {
          // The first entry by this name, as the catalog lists it.
          if (entryPath(zipName(item)) !== wanted || zipType(item) !== "file") return zip.readEntry();
          zip.openReadStream(item, (error, readable) => (error || !readable ? reject(error) : resolve(readable)));
        });
        zip.readEntry();
      }).catch((error) => {
        zip.close();
        throw error instanceof AppError ? error : new AppError(`That file can't be read (${(error as Error).message})`, 422, "INVALID_ARCHIVE");
      });
      void pipeline(stream, capped(entry.size), output, { signal }).catch(() => undefined).finally(() => zip.close());
    } else {
      const extract = tarStream.extract();
      const streams = await tarStreams(opened.handle, opened.real, opened.format === "tar.gz");
      const stop = new AbortController();
      output.on("close", () => stop.abort());
      let found = false;
      extract.on("entry", (header, stream, next) => {
        if (found || entryPath(header.name) !== wanted || tarType(header.type) !== "file") {
          stream.on("end", next);
          stream.resume();
          return;
        }
        found = true;
        // Reading stops once the file is through.
        void pipeline(stream, capped(entry.size), output).then(() => stop.abort(), (error: Error) => {
          output.destroy(error);
          stop.abort();
        });
      });
      void pipeline([...streams, extract], { signal: stop.signal }).then(
        () => { if (!found) output.destroy(new AppError("That file isn't in this archive", 404, "NOT_FOUND")); },
        (error: Error) => { if (!stop.signal.aborted || !found) output.destroy(error); },
      );
    }
    return { name, size: entry.size, stream: output };
  } finally {
    // The zip and tar readers have their own descriptors, so the archive's handle can go now.
    await opened.handle.close().catch(() => undefined);
  }
}

/** Forgets cached catalogs (tests). */
export function clearArchiveCatalogs() {
  catalogs.clear();
}
