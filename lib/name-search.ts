import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { acquireFilesystemLock, diskInfo, getMime, INTERNAL_NAMES, normalizeRelative, openDirectory, toEntry } from "./files";
import { AppError } from "./http";
import type { FileEntry } from "./types";

/**
 * Finds files and folders under a folder by name and by filters: kind, when modified, and size.
 * The walk holds the filesystem lock only to open the starting folder, so a long search over a
 * large tree never holds up other work; each folder is opened inside its parent's open handle
 * without following links, FilesDude's own folders are left out, and it stops when the request does.
 */
export type SearchKind = "any" | "folders" | "images" | "videos" | "audio" | "documents" | "archives";
export type NameSearch = { query?: string; hidden?: boolean; kind?: SearchKind; modifiedWithinDays?: number; minBytes?: number };
export const SEARCH_KINDS: SearchKind[] = ["any", "folders", "images", "videos", "audio", "documents", "archives"];

const MAX_RESULTS = 500;
const MAX_ENTRIES = 2_000_000;
const MAX_MILLISECONDS = 20_000;
const MAX_DEPTH = 64;
const STAT_BATCH = 32;
const ON_LINUX = process.platform === "linux";

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".rtf", ".csv", ".json", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".pages", ".numbers", ".key", ".epub", ".html", ".htm"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".iso", ".dmg", ".img"]);

/** Whether a file or folder is of the kind asked for. */
export function matchesKind(name: string, isDirectory: boolean, kind: SearchKind) {
  if (kind === "any") return true;
  if (kind === "folders") return isDirectory;
  if (isDirectory) return false;
  const extension = path.extname(name).toLowerCase();
  const mime = getMime(name);
  if (kind === "images") return mime.startsWith("image/") || [".heic", ".heif", ".tif", ".tiff", ".bmp", ".raw", ".cr2", ".nef", ".arw", ".dng"].includes(extension);
  // .ts is left out: it is far more often TypeScript than a video stream.
  if (kind === "videos") return mime.startsWith("video/") || [".m2ts", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"].includes(extension);
  if (kind === "audio") return mime.startsWith("audio/") || [".wma", ".aiff", ".alac", ".ape"].includes(extension);
  if (kind === "documents") return DOCUMENT_EXTENSIONS.has(extension);
  return ARCHIVE_EXTENSIONS.has(extension) || /\.tar\.(gz|bz2|xz|zst)$/i.test(name);
}

type Folder = { base: string; real: string; relative: string };

export async function searchNames(relativePath: string, options: NameSearch, signal?: AbortSignal, limits = { results: MAX_RESULTS, entries: MAX_ENTRIES, milliseconds: MAX_MILLISECONDS }) {
  const needle = (options.query ?? "").trim().toLocaleLowerCase();
  const kind = options.kind ?? "any";
  const since = options.modifiedWithinDays ? Date.now() - options.modifiedWithinDays * 24 * 60 * 60 * 1000 : null;
  const minBytes = options.minBytes ?? 0;
  // Size and age only apply to files, so folders are found only when no size is asked for.
  const needsStat = since !== null || minBytes > 0;
  const startRelative = normalizeRelative(relativePath).replace(/\/+$/, "");
  const release = await acquireFilesystemLock();
  let start: Awaited<ReturnType<typeof openDirectory>>;
  try {
    start = await openDirectory(startRelative);
  } finally {
    release();
  }
  const isReserved = await reservedPathCheck();
  const startedAt = Date.now();
  const entries: FileEntry[] = [];
  let scanned = 0;
  let stoppedBy: "results" | "limit" | "time" | null = null;

  const cancelled = () => new AppError("The search was cancelled", 499, "CANCELLED");

  async function consider(folder: Folder, name: string, isDirectory: boolean) {
    if (needle && !name.toLocaleLowerCase().includes(needle)) return;
    if (!matchesKind(name, isDirectory, kind)) return;
    const location = path.join(folder.base, name);
    let stat: Stats | undefined;
    if (needsStat) {
      stat = await fs.lstat(location).catch(() => undefined);
      if (!stat) return;
      if (minBytes > 0 && (!stat.isFile() || stat.size < minBytes)) return;
      if (since !== null && stat.mtimeMs < since) return;
    }
    if (entries.length >= limits.results) {
      stoppedBy = "results";
      return;
    }
    const entry = await toEntry(location, folder.relative ? `${folder.relative}/${name}` : name, name, stat).catch(() => null);
    if (!entry) return;
    // Matches are looked up in batches, so the list may have filled up meanwhile.
    if (entries.length >= limits.results) stoppedBy = "results";
    else entries.push(entry);
  }

  async function walk(folder: Folder, depth: number): Promise<void> {
    const matches: Array<{ name: string; isDirectory: boolean }> = [];
    const folders: string[] = [];
    let directory;
    try {
      directory = await fs.opendir(folder.base);
    } catch {
      return;
    }
    try {
      for await (const entry of directory) {
        if (signal?.aborted) throw cancelled();
        scanned += 1;
        if (scanned > limits.entries) {
          stoppedBy = "limit";
          return;
        }
        if (Date.now() - startedAt > limits.milliseconds) {
          stoppedBy = "time";
          return;
        }
        if (INTERNAL_NAMES.has(entry.name) || (!options.hidden && entry.name.startsWith("."))) continue;
        matches.push({ name: entry.name, isDirectory: entry.isDirectory() });
        if (entry.isDirectory()) folders.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (let index = 0; index < matches.length && !stoppedBy; index += STAT_BATCH) {
      await Promise.all(matches.slice(index, index + STAT_BATCH).map((match) => consider(folder, match.name, match.isDirectory)));
    }
    for (const name of folders) {
      if (signal?.aborted) throw cancelled();
      if (stoppedBy || depth >= MAX_DEPTH) return;
      const real = path.join(folder.real, name);
      if (isReserved(real)) continue;
      const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (!handle) continue;
      try {
        await walk({ base: ON_LINUX ? `/proc/self/fd/${handle.fd}` : real, real, relative: folder.relative ? `${folder.relative}/${name}` : name }, depth + 1);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }

  try {
    await walk({ base: start.base, real: start.real, relative: startRelative }, 0);
  } finally {
    await start.handle.close().catch(() => undefined);
  }
  const stopped = stoppedBy as "results" | "limit" | "time" | null;
  return { path: startRelative, entries, disk: await diskInfo(), truncated: stopped === "results", complete: stopped === null || stopped === "results", stoppedBy: stopped ?? undefined };
}
