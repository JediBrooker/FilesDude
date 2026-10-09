import crypto from "node:crypto";
import path from "node:path";
import type { Archiver } from "archiver";
import { appendDirectory, appendFileAndWait, reservedPathCheck } from "./archives";
import { acquireFilesystemLock, normalizeRelative, openVerifiedFile } from "./files";
import { AppError } from "./http";

// Downloading several selected items as one ZIP. The page first sends the paths (a same-origin
// request with the mutation header), which are checked and kept under a one-time ticket for this
// account; the browser then fetches the ZIP with the ticket in an ordinary download link. That keeps
// long selections out of URLs and means a link can't be forged into downloading other files.

export const MAX_BUNDLE_ITEMS = 1_000;
const TICKET_TTL_MS = 2 * 60 * 1000;
const MAX_TICKETS_PER_ACCOUNT = 10;

type Ticket = { account: string; paths: string[]; name: string; expires: number };
const tickets = new Map<string, Ticket>();

/** The selection, normalised: duplicates and items inside another selected folder are dropped. */
export function bundlePaths(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length) throw new AppError("Choose at least one item to download", 400, "INVALID_SELECTION");
  if (input.length > MAX_BUNDLE_ITEMS) throw new AppError(`Download at most ${MAX_BUNDLE_ITEMS.toLocaleString()} items at once`, 400, "TOO_MANY_ITEMS");
  const normalized = input.map((value) => {
    if (typeof value !== "string" || value.length > 4096) throw new AppError("Invalid path", 400, "INVALID_PATH");
    const relative = normalizeRelative(value);
    if (!relative) throw new AppError("Choose items inside a folder, not the whole root", 400, "INVALID_SELECTION");
    return relative;
  });
  const unique = [...new Set(normalized)];
  const chosen = new Set(unique);
  return unique.filter((relative) => {
    for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) if (chosen.has(parent)) return false;
    return true;
  });
}

/** The ZIP's name: the shared folder's name and the count, or "files" for items from several folders. */
export function bundleName(paths: string[]) {
  const parents = new Set(paths.map((relative) => path.posix.dirname(relative)));
  const parent = parents.size === 1 ? [...parents][0] : null;
  const base = parent && parent !== "." ? path.posix.basename(parent) : "files";
  return `${base} (${paths.length} item${paths.length === 1 ? "" : "s"}).zip`;
}

/** Checks every selected item can be downloaded, so problems are reported before the ZIP starts. */
export async function checkBundle(paths: string[]) {
  const isReserved = await reservedPathCheck();
  for (const relative of paths) {
    const release = await acquireFilesystemLock();
    let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
    try {
      opened = await openVerifiedFile(relative);
    } finally {
      release();
    }
    try {
      if (isReserved(opened.openedPath)) throw new AppError("That item is reserved by FilesDude", 403, "RESERVED_PATH");
      if (!opened.stat.isFile() && !opened.stat.isDirectory()) throw new AppError(`${path.posix.basename(relative)} can't be downloaded: only files and folders can`, 400, "UNSUPPORTED_FILE_TYPE");
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
}

export function createDownloadTicket(account: string, paths: string[]) {
  const now = Date.now();
  for (const [token, ticket] of tickets) if (ticket.expires <= now) tickets.delete(token);
  // An account keeps only its latest few tickets; the oldest goes first.
  const own = [...tickets].filter(([, ticket]) => ticket.account === account);
  for (const [token] of own.slice(0, Math.max(0, own.length - MAX_TICKETS_PER_ACCOUNT + 1))) tickets.delete(token);
  const token = crypto.randomBytes(24).toString("base64url");
  tickets.set(token, { account, paths, name: bundleName(paths), expires: now + TICKET_TTL_MS });
  return token;
}

/** The ticket's selection, once, and only for the account it was made for. */
export function takeDownloadTicket(token: string, account: string) {
  const ticket = tickets.get(token);
  if (!ticket || ticket.account !== account) return null;
  tickets.delete(token);
  return ticket.expires > Date.now() ? ticket : null;
}

// Two selected items from different folders may share a name; later ones get " (2)" and so on.
function uniqueName(name: string, used: Set<string>) {
  const extension = path.posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) candidate = `${stem} (${index})${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Adds each selected item to the archive, opening one at a time (the filesystem lock is held only
 * while opening). Folders are added through their open handles as for a single folder's download;
 * an item removed since the download was requested is left out.
 */
export async function appendBundle(archive: Archiver, paths: string[], signal?: AbortSignal) {
  const isReserved = await reservedPathCheck();
  const used = new Set<string>();
  for (const relative of paths) {
    if (signal?.aborted) throw new AppError("The download was cancelled", 499, "CANCELLED");
    const release = await acquireFilesystemLock();
    let opened: Awaited<ReturnType<typeof openVerifiedFile>> | null;
    try {
      opened = await openVerifiedFile(relative).catch(() => null);
    } finally {
      release();
    }
    if (!opened) continue;
    const { absolute, handle, openedPath, stat } = opened;
    let owned = true;
    try {
      if (isReserved(openedPath)) continue;
      const name = uniqueName(path.basename(absolute) || "item", used);
      if (stat.isDirectory()) {
        archive.append(Buffer.alloc(0), { name: `${name}/`, type: "directory", stats: stat });
        owned = false;
        await appendDirectory(archive, handle, openedPath, name, isReserved, signal);
      } else if (stat.isFile() && stat.size === 0) {
        archive.append(Buffer.alloc(0), { name, stats: stat });
      } else if (stat.isFile()) {
        // Only the size measured at open is read; the read stream owns the handle and closes it.
        owned = false;
        await appendFileAndWait(archive, handle.createReadStream({ start: 0, end: stat.size - 1 }), name, stat, signal);
      }
    } finally {
      if (owned) await handle.close().catch(() => undefined);
    }
  }
}
