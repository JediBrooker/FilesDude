import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { activityCategory, activityUser, type ActivityCategory } from "./activity-text";
import { AUDIT_FILE, isAuditArchive } from "./audit";
import { config } from "./config";
import { AppError } from "./http";

/**
 * The audit log, newest first, for the owner's Activity view. Pages continue from a cursor naming
 * the log file (by inode, so rotation in between doesn't lose the place) and the byte offset reached.
 * Each page reads a bounded amount, so a filter that matches little can't make one request scan the
 * whole history; the view then offers to keep looking.
 */
export type ActivityEntry = { at: string; event: string; [key: string]: unknown };
export type ActivityFilter = { category?: ActivityCategory | "all"; user?: string; query?: string };

const CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const PAGE_SIZE = 100;

// Events kept in the log but not shown: looking at an item's details, and bulk-rename previews.
const HIDDEN = new Set(["fs.details"]);

// What's shown of each entry: long strings and lists are cut short, and deep nesting stops.
function trim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (!value || typeof value !== "object") return value;
  if (depth > 3) return "…";
  // Lists were already cut to 25 (plus a note of how many more) when written.
  if (Array.isArray(value)) {
    const items = value.slice(0, 26).map((item) => trim(item, depth + 1));
    return value.length > 26 ? [...items, `…and ${value.length - 26} more`] : items;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, trim(item, depth + 1)]));
}

export function matchesFilter(entry: ActivityEntry, line: string, filter: ActivityFilter) {
  // Entries from before `apply` was recorded count as applied.
  if (HIDDEN.has(entry.event) || (entry.event === "fs.bulkRename" && entry.apply === false)) return false;
  if (filter.category && filter.category !== "all" && activityCategory(entry.event) !== filter.category) return false;
  if (filter.user && activityUser(entry).toLowerCase() !== filter.user.toLowerCase()) return false;
  if (filter.query && !line.toLowerCase().includes(filter.query.toLowerCase())) return false;
  return true;
}

// A cursor names a log file by inode and by the time of its first entry (so a new file that
// happens to reuse a removed one's inode isn't mistaken for it), and the byte offset reached.
type Cursor = { ino: number; offset: number; mark: string };

function parseCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  const match = /^(\d{1,20})\.(\d{1,15})\.(\d{0,15})$/.exec(value);
  if (!match) throw new AppError("Invalid activity cursor", 400, "INVALID_CURSOR");
  return { ino: Number(match[1]), offset: Number(match[2]), mark: match[3] };
}

type LogFile = { handle: Awaited<ReturnType<typeof fs.open>>; ino: number; size: number; mark: string };

const cursorFor = (file: LogFile, offset: number) => `${file.ino}.${offset}.${file.mark}`;

// The current log and its archives, newest first, opened up front (so a rotation while reading
// can't swap one file for another under the same name) and never through a symlink.
async function openLogFiles() {
  const names = await fs.readdir(config.stateDir).catch(() => [] as string[]);
  const candidates: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (name !== AUDIT_FILE && !isAuditArchive(name)) continue;
    const stat = await fs.lstat(path.join(config.stateDir, name)).catch(() => null);
    if (stat?.isFile()) candidates.push({ name, mtime: name === AUDIT_FILE ? Infinity : stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const files: LogFile[] = [];
  for (const { name } of candidates) {
    const handle = await fs.open(path.join(config.stateDir, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) continue;
    const stat = await handle.stat();
    const head = Buffer.alloc(40);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const at = /^\{"at":"([^"]+)"/.exec(head.toString("utf8", 0, bytesRead))?.[1];
    const time = at ? Date.parse(at) : NaN;
    files.push({ handle, ino: stat.ino, size: stat.size, mark: Number.isFinite(time) ? String(time) : "" });
  }
  return files;
}

// Where to continue once a file is finished: the end of the next older file, if there is one.
function nextFileCursor(files: LogFile[], index: number) {
  const next = files[index + 1];
  return next ? cursorFor(next, next.size) : null;
}

/** One page of matching entries, newest first, and the cursor for the next (null at the start of the log). */
export async function readActivity(filter: ActivityFilter = {}, cursorValue?: string | null, limit = PAGE_SIZE) {
  const cursor = parseCursor(cursorValue);
  const files = await openLogFiles();
  try {
    return await readFiles(files, cursor, filter, limit);
  } finally {
    await Promise.all(files.map((file) => file.handle.close().catch(() => undefined)));
  }
}

// One line of the log as an entry, if it is one and matches; a line that can't be read is skipped.
function entryFrom(text: string, filter: ActivityFilter): ActivityEntry | null {
  try {
    const entry = JSON.parse(text) as ActivityEntry;
    if (!entry || typeof entry !== "object" || typeof entry.event !== "string" || typeof entry.at !== "string") return null;
    return matchesFilter(entry, text, filter) ? (trim(entry) as ActivityEntry) : null;
  } catch {
    return null;
  }
}

async function readFiles(files: LogFile[], cursor: Cursor | null, filter: ActivityFilter, limit: number) {
  let fileIndex = 0;
  let end = files[0]?.size ?? 0;
  if (cursor) {
    fileIndex = files.findIndex((file) => file.ino === cursor.ino && file.mark === cursor.mark && cursor.offset <= file.size);
    // The file the cursor was in is no longer kept.
    if (fileIndex < 0) return { entries: [], cursor: null };
    end = cursor.offset;
  }
  const entries: ActivityEntry[] = [];
  let scanned = 0;
  while (fileIndex < files.length) {
    const file = files[fileIndex];
    const { handle } = file;
    {
      // Reads backwards in chunks; `carry` holds the start of a line split across chunks.
      let carry = Buffer.alloc(0);
      while (end > 0 || carry.length) {
        if (entries.length >= limit || scanned >= MAX_SCAN_BYTES) return { entries, cursor: cursorFor(file, end + carry.length) };
        const start = Math.max(0, end - CHUNK_BYTES);
        const chunk = Buffer.alloc(end - start);
        if (chunk.length) await handle.read(chunk, 0, chunk.length, start);
        scanned += chunk.length;
        const data = Buffer.concat([chunk, carry]);
        // Complete lines in this chunk, newest first, each with where it starts in the file.
        const lines: Array<{ text: Buffer; at: number }> = [];
        let cut = data.length;
        for (let index = data.length - 1; index >= 0; index -= 1) {
          if (data[index] !== 0x0a) continue;
          if (index + 1 < cut) lines.push({ text: data.subarray(index + 1, cut), at: start + index + 1 });
          cut = index;
        }
        if (start === 0) {
          if (cut > 0) lines.push({ text: data.subarray(0, cut), at: 0 });
          carry = Buffer.alloc(0);
        } else {
          // An unfinished line longer than any real entry is dropped rather than buffered forever.
          carry = cut > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(data.subarray(0, cut));
        }
        end = start;
        for (const line of lines) {
          const entry = entryFrom(line.text.toString("utf8"), filter);
          if (!entry) continue;
          entries.push(entry);
          // A full page: the next one continues with the lines before this one.
          if (entries.length >= limit) return { entries, cursor: line.at > 0 ? cursorFor(file, line.at) : nextFileCursor(files, fileIndex) };
        }
      }
    }
    fileIndex += 1;
    end = files[fileIndex]?.size ?? 0;
  }
  return { entries, cursor: null };
}
