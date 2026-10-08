import { constants } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { getMime, INTERNAL_NAMES, relativeFromAbsolute, safeResolve, verifyFileHandleWithinRoot } from "./files";
import { AppError } from "./http";
import type { ContentMatch, ContentSearchHit, ContentSearchResult } from "./types";

// Searches text inside files below a folder. It walks through open directory descriptors, never
// follows symlinks, opens nothing that could block (FIFOs, devices), skips FilesDude's internal
// folders, and stops at fixed limits so a search always finishes well inside a proxy timeout.
// Matching is plain substring search, never a user-supplied regular expression.
export const CONTENT_SEARCH_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 20_000,
  maxBytes: 256 * 1024 * 1024,
  maxMs: 15_000,
  maxHits: 200,
  maxDepth: 20,
  matchesPerFile: 3,
};

const ON_LINUX = process.platform === "linux";
const BINARY_TYPES = /^(image|video|audio)\/|^application\/(zip|gzip|x-tar|pdf)$/;
const SNIPPET_LENGTH = 200;

function descriptorPath(handle: FileHandle, fallback: string) {
  return ON_LINUX ? `/proc/self/fd/${handle.fd}` : fallback;
}

function snippet(line: string, index: number) {
  if (line.length <= SNIPPET_LENGTH) return line;
  const start = Math.max(0, Math.min(index - 60, line.length - SNIPPET_LENGTH));
  const end = Math.min(line.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

// Reads no more than the size measured at open, so a file growing meanwhile can't stretch the read.
async function readMeasured(handle: FileHandle, size: number) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function searchContents(
  relativePath: string,
  query: string,
  options: { caseSensitive?: boolean; showHidden?: boolean; signal?: AbortSignal; limits?: Partial<typeof CONTENT_SEARCH_LIMITS> } = {},
): Promise<ContentSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 200) throw new AppError("Search for 2 to 200 characters", 400, "INVALID_QUERY");
  const caseSensitive = Boolean(options.caseSensitive);
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  const limits = { ...CONTENT_SEARCH_LIMITS, ...options.limits };
  const isReserved = await reservedPathCheck();
  const started = Date.now();
  const hits: ContentSearchHit[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  let stoppedBy: ContentSearchResult["stoppedBy"] = null;
  const finished = () => stoppedBy !== null || Boolean(options.signal?.aborted);

  async function searchFile(location: string, expected: string, name: string) {
    if (BINARY_TYPES.test(getMime(name))) {
      skippedFiles += 1;
      return;
    }
    if (scannedFiles >= limits.maxFiles) {
      stoppedBy = "files";
      return;
    }
    const handle = await fsp.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY).catch(() => null);
    if (!handle) {
      skippedFiles += 1;
      return;
    }
    try {
      const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, expected);
      if (!stat.isFile() || isReserved(openedPath)) return;
      if (stat.size > limits.maxFileBytes) {
        skippedFiles += 1;
        return;
      }
      if (scannedBytes + stat.size > limits.maxBytes) {
        stoppedBy = "bytes";
        return;
      }
      const data = await readMeasured(handle, stat.size);
      scannedFiles += 1;
      scannedBytes += data.length;
      // A NUL byte near the start means binary data, not text.
      if (data.subarray(0, 8000).includes(0)) {
        skippedFiles += 1;
        return;
      }
      const text = data.toString("utf8");
      if (!(caseSensitive ? text : text.toLowerCase()).includes(needle)) return;
      const matches: ContentMatch[] = [];
      let matchCount = 0;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
        const position = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
        if (position < 0) continue;
        matchCount += 1;
        if (matches.length < limits.matchesPerFile) matches.push({ line: index + 1, text: snippet(line, position) });
      }
      hits.push({ path: relativeFromAbsolute(openedPath), name, size: stat.size, modified: stat.mtime.toISOString(), mime: getMime(name), matches, matchCount });
      if (hits.length >= limits.maxHits) stoppedBy = "results";
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // Depth-first, so at most one open descriptor per level. Takes ownership of `handle`.
  async function walk(handle: FileHandle, openedPath: string, depth: number) {
    const directoryPath = descriptorPath(handle, openedPath);
    const directory = await fsp.opendir(directoryPath).catch(() => null);
    if (!directory) {
      skippedFiles += 1;
      await handle.close().catch(() => undefined);
      return;
    }
    try {
      for await (const entry of directory) {
        if (finished()) return;
        if (Date.now() - started > limits.maxMs) {
          stoppedBy = "time";
          return;
        }
        if (INTERNAL_NAMES.has(entry.name) || (!options.showHidden && entry.name.startsWith(".")) || entry.isSymbolicLink()) continue;
        const location = path.join(directoryPath, entry.name);
        const expected = path.join(openedPath, entry.name);
        if (entry.isDirectory()) {
          if (depth >= limits.maxDepth) {
            skippedFiles += 1;
            continue;
          }
          const child = await fsp.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
          if (!child) {
            skippedFiles += 1;
            continue;
          }
          const verified = await verifyFileHandleWithinRoot(child, expected).catch(() => null);
          if (!verified || isReserved(verified.openedPath)) {
            await child.close().catch(() => undefined);
            continue;
          }
          await walk(child, verified.openedPath, depth + 1);
        } else if (entry.isFile()) {
          await searchFile(location, expected, entry.name);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
  }

  const base = await safeResolve(relativePath);
  const baseHandle = await fsp.open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK).catch(() => {
    throw new AppError("Choose a folder to search", 400, "NOT_A_DIRECTORY");
  });
  const verified = await verifyFileHandleWithinRoot(baseHandle, base).catch(async (error) => {
    await baseHandle.close().catch(() => undefined);
    throw error;
  });
  if (isReserved(verified.openedPath)) {
    await baseHandle.close().catch(() => undefined);
    throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
  }
  await walk(baseHandle, verified.openedPath, 0);
  if (options.signal?.aborted) throw new AppError("Search cancelled", 499, "CANCELLED");
  hits.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  return { query: trimmed, hits, scannedFiles, scannedBytes, skippedFiles, durationMs: Date.now() - started, stoppedBy };
}
