import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { activityCategory, activityUser, type ActivityCategory } from "./activity-text";
import { AUDIT_FILES } from "./audit";
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

// What's shown of each entry: long strings and lists are cut short.
function trim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => trim(item, depth + 1));
    return value.length > 20 ? [...items, `…and ${value.length - 20} more`] : items;
  }
  if (value && typeof value === "object") {
    if (depth > 3) return "…";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, trim(item, depth + 1)]));
  }
  return value;
}

export function matchesFilter(entry: ActivityEntry, line: string, filter: ActivityFilter) {
  if (HIDDEN.has(entry.event) || (entry.event === "fs.bulkRename" && !entry.apply)) return false;
  if (filter.category && filter.category !== "all" && activityCategory(entry.event) !== filter.category) return false;
  if (filter.user && activityUser(entry).toLowerCase() !== filter.user.toLowerCase()) return false;
  if (filter.query && !line.toLowerCase().includes(filter.query.toLowerCase())) return false;
  return true;
}

type Cursor = { ino: number; offset: number };

function parseCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  const match = /^(\d{1,20})\.(\d{1,15})$/.exec(value);
  if (!match) throw new AppError("Invalid activity cursor", 400, "INVALID_CURSOR");
  return { ino: Number(match[1]), offset: Number(match[2]) };
}

async function logFiles() {
  const files: Array<{ location: string; ino: number; size: number }> = [];
  for (const name of AUDIT_FILES) {
    const location = path.join(config.stateDir, name);
    const stat = await fs.lstat(location).catch(() => null);
    if (stat?.isFile()) files.push({ location, ino: stat.ino, size: stat.size });
  }
  return files;
}

// Where to continue once a file is finished: the end of the next older file, if there is one.
function nextFileCursor(files: Array<{ ino: number; size: number }>, index: number) {
  const next = files[index + 1];
  return next ? `${next.ino}.${next.size}` : null;
}

/** One page of matching entries, newest first, and the cursor for the next (null at the start of the log). */
export async function readActivity(filter: ActivityFilter = {}, cursorValue?: string | null, limit = PAGE_SIZE) {
  const files = await logFiles();
  const cursor = parseCursor(cursorValue);
  let fileIndex = 0;
  let end = files[0]?.size ?? 0;
  if (cursor) {
    fileIndex = files.findIndex((file) => file.ino === cursor.ino);
    // The file the cursor was in has rotated out of the kept history.
    if (fileIndex < 0) return { entries: [], cursor: null };
    end = Math.min(cursor.offset, files[fileIndex].size);
  }
  const entries: ActivityEntry[] = [];
  let scanned = 0;
  while (fileIndex < files.length) {
    const file = files[fileIndex];
    const handle = await fs.open(file.location, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Reads backwards in chunks; `carry` holds the start of a line split across chunks.
      let carry = Buffer.alloc(0);
      while (end > 0 || carry.length) {
        if (entries.length >= limit || scanned >= MAX_SCAN_BYTES) return { entries, cursor: `${file.ino}.${end + carry.length}` };
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
          const text = line.text.toString("utf8");
          let entry: ActivityEntry;
          try {
            entry = JSON.parse(text);
          } catch {
            continue;
          }
          if (!entry || typeof entry !== "object" || typeof entry.event !== "string" || typeof entry.at !== "string") continue;
          if (!matchesFilter(entry, text, filter)) continue;
          entries.push(trim(entry) as ActivityEntry);
          // A full page: the next one continues with the lines before this one.
          if (entries.length >= limit) return { entries, cursor: line.at > 0 ? `${file.ino}.${line.at}` : nextFileCursor(files, fileIndex) };
        }
      }
    } finally {
      await handle.close();
    }
    fileIndex += 1;
    end = files[fileIndex]?.size ?? 0;
  }
  return { entries, cursor: null };
}
