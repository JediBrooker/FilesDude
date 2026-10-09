import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// The audit log: one JSON object per line in audit.jsonl in the state directory. At 8 MB the file is
// set aside as a dated archive (audit-<time>.jsonl) and a new one started. Archives are kept for at
// least 30 days, however much is written (so nobody can push recent history out by flooding the
// log), and older ones once history passes 256 MB; only past 1 GB in total are recent ones removed,
// to protect the disk. Every rotation, removal, and dropped entry is itself recorded.
export const AUDIT_FILE = "audit.jsonl";
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const KEEP_BYTES = 256 * 1024 * 1024;
const HARD_LIMIT_BYTES = 1024 * 1024 * 1024;
const KEEP_DAYS = 30;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_PENDING = 2_000;

/** Archived logs: dated ones, and the numbered ones earlier versions made. */
export function isAuditArchive(name: string) {
  return /^audit-\d{8}T\d{9}Z(-\d+)?\.jsonl$/.test(name) || /^audit\.jsonl\.\d+$/.test(name);
}

/**
 * A record's details, bounded so no single entry can be large: long text is cut, lists keep their
 * first 25 items (and say how many more there were), and nesting stops at four levels.
 */
export function boundRecord(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value !== "object" || value === null) return typeof value === "bigint" ? String(value) : value;
  if (depth >= 4) return "…";
  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((item) => boundRecord(item, depth + 1));
    return value.length > 25 ? [...items, `…and ${value.length - 25} more`] : items;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key.slice(0, 64), boundRecord(item, depth + 1)]));
}

function line(event: string, details: Record<string, unknown>, at = new Date().toISOString()) {
  // `at` and `event` come first and can't be overwritten by details.
  const bounded = boundRecord(details) as Record<string, unknown>;
  delete bounded.at;
  delete bounded.event;
  const text = JSON.stringify({ at, event, ...bounded });
  if (Buffer.byteLength(text) <= MAX_RECORD_BYTES) return `${text}\n`;
  const username = typeof details.username === "string" ? details.username.slice(0, 64) : undefined;
  return `${JSON.stringify({ at, event, username, truncated: true, bytes: Buffer.byteLength(text) })}\n`;
}

// A dated name no archive has yet (two rotations in the same millisecond get -2, -3, ...).
async function archiveName(directory: string) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  for (let index = 1; ; index += 1) {
    const name = `audit-${stamp}${index > 1 ? `-${index}` : ""}.jsonl`;
    if (!(await fs.lstat(path.join(directory, name)).catch(() => null))) return name;
  }
}

// Removes archives beyond what is kept, oldest first, and says which.
async function prune(directory: string) {
  const archives = [];
  for (const name of await fs.readdir(directory)) {
    if (!isAuditArchive(name)) continue;
    const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
    if (stat?.isFile()) archives.push({ name, size: stat.size, mtime: stat.mtimeMs });
  }
  archives.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  let total = 0;
  for (const archive of archives) {
    total += archive.size;
    const old = Date.now() - archive.mtime > KEEP_DAYS * 24 * 60 * 60 * 1000;
    if ((total > KEEP_BYTES && old) || total > HARD_LIMIT_BYTES) {
      await fs.rm(path.join(directory, archive.name), { force: true });
      removed.push(archive.name);
    }
  }
  return removed;
}

let queue: Promise<void> = Promise.resolve();
let pending = 0;
let dropped = 0;

async function write(event: string, details: Record<string, unknown>) {
  const directory = config.stateDir;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const current = path.join(directory, AUDIT_FILE);
  let text = line(event, details);
  if (dropped) {
    text = line("audit.dropped", { count: dropped }) + text;
    dropped = 0;
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  let handle = await fs.open(current, flags, 0o600);
  try {
    const { size } = await handle.stat();
    if (size > 0 && size + Buffer.byteLength(text) > MAX_AUDIT_BYTES) {
      await handle.close();
      const archived = await archiveName(directory);
      await fs.rename(current, path.join(directory, archived));
      const removed = await prune(directory);
      handle = await fs.open(current, flags, 0o600);
      text = line("audit.rotated", { archived, removed: removed.length ? removed : undefined }) + text;
    }
    await handle.appendFile(text);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Records an event. Writes happen one at a time (so rotation never races an append); if thousands
 * are waiting, new ones are counted and the count recorded instead, so a flood can't hold up
 * sign-ins or exhaust memory.
 */
export async function audit(event: string, details: Record<string, unknown> = {}) {
  if (pending >= MAX_PENDING) {
    dropped += 1;
    return;
  }
  pending += 1;
  const run = queue.then(() => write(event, details));
  queue = run.catch(() => undefined);
  try {
    await run;
  } catch (error) {
    console.error("Unable to write audit event", error);
  } finally {
    pending -= 1;
  }
}
