import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { ensureRoot, normalizeRelative, safeResolve, verifyFileHandleWithinRoot, type AnchoredDirectory, type CopiedItems } from "./files";
import { verifyPassword } from "./auth";
import { hashPassword } from "./credentials";
import { AppError } from "./http";
import type { ShareLink } from "./types";

// A share link is /s/<id>.<signature>, where the signature is an HMAC of the id under a key derived
// from the session secret. Only the id is stored, so the state file alone cannot be used to download
// anything, and rotating the session secret invalidates every link along with every session.
//
// A link is bound to the item itself (device and inode), not just its path, and is opened without
// following symlinks: users who can change the shared folder (for example inside an LXC container)
// cannot swap the item for a link to something else, and a different item later created at the
// same path is never served.
//
// An upload link (kind "upload") is the reverse: anyone with it can add files to a folder, up to a
// total size and number of files, but can't see, change, or download anything in it.
interface StoredShare {
  id: string;
  path: string;
  name: string;
  type: "file" | "directory";
  dev: string;
  ino: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number | null;
  downloads: number;
  kind?: "upload";
  maxBytes?: number;
  maxFiles?: number | null;
  uploadedBytes?: number;
  uploadedFiles?: number;
  /** A link with a password: its scrypt hash (the password itself is never stored). */
  passwordHash?: string;
}

export type UploadShare = StoredShare & { kind: "upload"; maxBytes: number; maxFiles: number | null; uploadedBytes: number; uploadedFiles: number };

export const MAX_SHARE_HOURS = 30 * 24;
const MAX_SHARE_DOWNLOADS = 1_000;
export const MAX_UPLOAD_LINK_BYTES = 1024 ** 4;
const MAX_UPLOAD_LINK_FILES = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
let mutationQueue: Promise<void> = Promise.resolve();

function sharesFile() {
  return path.join(config.stateDir, "shares.json");
}

// A key separate from the one signing sessions, so a share signature can never be a session's.
function shareKey() {
  return Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), "filesdude-share-v1", 32));
}

function signatureFor(id: string) {
  return crypto.createHmac("sha256", shareKey()).update(id).digest("base64url");
}

function sharePath(relativePath: string) {
  return normalizeRelative(relativePath).replace(/\/+$/, "");
}

function isActive(share: StoredShare, now = Date.now()) {
  return Date.parse(share.expiresAt) > now && (share.maxDownloads === null || share.downloads < share.maxDownloads);
}

export const isUploadShare = (share: StoredShare): share is UploadShare => share.kind === "upload";

// --- Passwords on links ---
//
// A link can need a password as well. Entering it on the link's page sets a cookie for that link
// only (its path), signed and bound to the link and its password, which lasts 12 hours. Guesses are
// limited per visitor and per link, and failures are recorded.
const MIN_LINK_PASSWORD = 8;
const UNLOCK_SECONDS = 12 * 60 * 60;
const GUESS_WINDOW_MS = 15 * 60_000;
const GUESSES_PER_VISITOR = 10;
const GUESSES_PER_LINK = 50;
const guesses = new Map<string, { count: number; resetAt: number }>();

async function linkPasswordHash(password: unknown) {
  if (password === undefined || password === null || password === "") return undefined;
  if (typeof password !== "string" || password.length < MIN_LINK_PASSWORD || password.length > 256) throw new AppError(`A link's password must be ${MIN_LINK_PASSWORD} to 256 characters`, 400, "INVALID_PASSWORD");
  return hashPassword(password);
}

export const isProtected = (share: StoredShare) => Boolean(share.passwordHash);

function unlockKey() {
  return Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), "filesdude-share-unlock-v1", 32));
}

const unlockCookieName = (share: StoredShare) => `fdl_${share.id}`;
const unlockSignature = (share: StoredShare, expires: number) => crypto.createHmac("sha256", unlockKey()).update(`${share.id}|${expires}|${share.passwordHash}`).digest("base64url");

/** Whether this visitor may use the link: it has no password, or they entered it (per its cookie). */
export function isUnlocked(share: StoredShare, cookieHeader: string | null) {
  if (!share.passwordHash) return true;
  const name = unlockCookieName(share);
  const value = (cookieHeader ?? "").split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
  const [expiresRaw, supplied, extra] = value.split(".");
  const expires = Number(expiresRaw);
  if (!supplied || extra !== undefined || !Number.isSafeInteger(expires) || expires * 1000 <= Date.now()) return false;
  const expected = Buffer.from(unlockSignature(share, expires));
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function currentGuesses(key: string, now: number) {
  const entry = guesses.get(key);
  return entry && entry.resetAt > now ? entry : null;
}

function startGuesses(key: string, now: number) {
  if (guesses.size > 10_000) for (const [stored, entry] of guesses) if (entry.resetAt <= now) guesses.delete(stored);
  const entry = { count: 0, resetAt: now + GUESS_WINDOW_MS };
  guesses.set(key, entry);
  return entry;
}

/**
 * Checks a password for a link, within its limits on wrong guesses: per visitor first, so one visitor
 * past theirs doesn't use up the link's, then per link. A try is counted before checking (so tries
 * sent together can't get past the limits) and given back if the password is right. Returns the
 * Set-Cookie value that unlocks the link for 12 hours.
 */
export async function unlockShare(share: StoredShare, password: unknown, address: string, token: string, secure: boolean) {
  if (!share.passwordHash) throw new AppError("This link doesn't need a password", 400, "NOT_PROTECTED");
  const now = Date.now();
  const visitorKey = `${share.id}|${address}`;
  const linkKey = `${share.id}|*`;
  const visitorSoFar = currentGuesses(visitorKey, now);
  if (visitorSoFar && visitorSoFar.count >= GUESSES_PER_VISITOR) throw new AppError("Too many wrong passwords. Try again in 15 minutes.", 429, "TOO_MANY_GUESSES");
  const link = currentGuesses(linkKey, now) ?? startGuesses(linkKey, now);
  if (link.count >= GUESSES_PER_LINK) {
    // The owner hears about it once each time a link is locked.
    const firstLock = !(link as { notified?: boolean }).notified;
    (link as { notified?: boolean }).notified = true;
    throw Object.assign(new AppError("Too many wrong passwords have been tried on this link. Try again in 15 minutes.", 429, "LINK_LOCKED"), { firstLock });
  }
  const visitor = visitorSoFar ?? startGuesses(visitorKey, now);
  visitor.count += 1;
  link.count += 1;
  const valid = typeof password === "string" && password.length <= 256 && (await verifyPassword(password, share.passwordHash));
  if (!valid) throw new AppError("That password isn't right", 401, "WRONG_PASSWORD");
  // Only wrong guesses count: the right password gives its try back.
  guesses.delete(visitorKey);
  link.count = Math.max(0, link.count - 1);
  const expires = Math.floor(now / 1000) + UNLOCK_SECONDS;
  return `${unlockCookieName(share)}=${expires}.${unlockSignature(share, expires)}; Path=/s/${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_SECONDS}${secure ? "; Secure" : ""}`;
}

function toLink(stored: StoredShare): ShareLink {
  const { passwordHash, ...share } = stored;
  const url = `/s/${share.id}.${signatureFor(share.id)}`;
  const locked = Boolean(passwordHash);
  if (isUploadShare(stored)) return { ...share, kind: "upload", url, protected: locked };
  return { ...share, kind: "download", url, protected: locked };
}

const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const validUploadFields = (item: StoredShare) => item.kind === undefined
  || (item.kind === "upload" && item.type === "directory" && isCount(item.maxBytes) && (item.maxFiles === null || isCount(item.maxFiles)) && isCount(item.uploadedBytes) && isCount(item.uploadedFiles));

// Links with a password are kept in a file of their own, which versions of FilesDude from before
// passwords don't read: rolled back, they lose those links rather than serve them to anyone.
function protectedSharesFile() {
  return path.join(config.stateDir, "protected-shares.json");
}

async function readShares(): Promise<StoredShare[]> {
  const [open, locked] = await Promise.all([readShareFile(sharesFile()), readShareFile(protectedSharesFile())]);
  const protectedIds = new Set(locked.filter((share) => share.passwordHash).map((share) => share.id));
  return [...open.filter((share) => !protectedIds.has(share.id)), ...locked.filter((share) => share.passwordHash)];
}

async function readShareFile(file: string): Promise<StoredShare[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredShare => Boolean(item) && typeof item.id === "string" && ID_PATTERN.test(item.id)
      && typeof item.path === "string" && typeof item.name === "string" && (item.type === "file" || item.type === "directory")
      && typeof item.dev === "string" && typeof item.ino === "string"
      && typeof item.createdAt === "string" && typeof item.expiresAt === "string" && Number.isInteger(item.downloads)
      && (item.maxDownloads === null || Number.isInteger(item.maxDownloads)) && validUploadFields(item)
      && (item.passwordHash === undefined || (typeof item.passwordHash === "string" && item.passwordHash.startsWith("scrypt$"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw new AppError("Shared links data is corrupted", 500, "SHARES_CORRUPT");
    throw error;
  }
}

async function writeShares(shares: StoredShare[]) {
  await writeShareFile(protectedSharesFile(), shares.filter((share) => share.passwordHash));
  await writeShareFile(sharesFile(), shares.filter((share) => !share.passwordHash));
}

async function writeShareFile(file: string, shares: StoredShare[]) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `shares-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(shares, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

// Serializes read-modify-write cycles; expired and used-up links are dropped on every write.
function mutate<T>(operation: (shares: StoredShare[]) => Promise<{ shares: StoredShare[]; result: T }>) {
  const run = async () => {
    const current = await readShares();
    const { shares, result } = await operation(current.filter((share) => isActive(share)));
    // Most rewrites (one per moved item) change nothing, so they skip the fsynced write.
    if (JSON.stringify(shares) !== JSON.stringify(current)) await writeShares(shares);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function requireSharing() {
  if (!config.sharingEnabled) throw new AppError("Sharing is turned off on this server", 403, "SHARING_DISABLED");
}

export async function createShare(relativePath: string, hours: number, maxDownloads: number | null, password?: unknown): Promise<ShareLink> {
  requireSharing();
  const passwordHash = await linkPasswordHash(password);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SHARE_HOURS) throw new AppError("Links can last from 1 hour to 30 days", 400, "INVALID_EXPIRY");
  if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > MAX_SHARE_DOWNLOADS)) {
    throw new AppError("Choose a download limit between 1 and 1,000, or no limit", 400, "INVALID_LIMIT");
  }
  const normalized = sharePath(relativePath);
  if (!normalized) throw new AppError("The root folder can't be shared", 400, "ROOT_SHARE");
  const candidate = await safeResolve(normalized, { followSymlink: false });
  const stat = await fs.lstat(candidate, { bigint: true });
  if (stat.isSymbolicLink()) throw new AppError("Links can't be shared; share the item they point to instead", 400, "UNSUPPORTED_SHARE");
  if (!stat.isFile() && !stat.isDirectory()) throw new AppError("Only files and folders can be shared", 400, "UNSUPPORTED_SHARE");
  if ((await fs.realpath(candidate)) !== candidate) throw new AppError("Share the item from its real location, not through a linked folder", 400, "UNSUPPORTED_SHARE");
  const now = Date.now();
  const share: StoredShare = {
    id: crypto.randomBytes(12).toString("base64url"),
    path: normalized,
    name: path.posix.basename(normalized),
    type: stat.isDirectory() ? "directory" : "file",
    dev: String(stat.dev),
    ino: String(stat.ino),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    maxDownloads,
    downloads: 0,
    ...(passwordHash ? { passwordHash } : {}),
  };
  return mutate(async (shares) => ({ shares: [...shares, share], result: toLink(share) }));
}

/**
 * Creates an upload link to a folder: anyone with it can add up to `maxBytes` in total (and up to
 * `maxFiles` files, or any number) until it expires. Bound to the folder as download links are.
 */
export async function createUploadLink(relativePath: string, hours: number, maxBytes: number, maxFiles: number | null, password?: unknown): Promise<ShareLink> {
  requireSharing();
  const passwordHash = await linkPasswordHash(password);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SHARE_HOURS) throw new AppError("Links can last from 1 hour to 30 days", 400, "INVALID_EXPIRY");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > MAX_UPLOAD_LINK_BYTES) throw new AppError("Choose a total upload size between 1 MB and 1 TB", 400, "INVALID_LIMIT");
  if (maxFiles !== null && (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_UPLOAD_LINK_FILES)) {
    throw new AppError("Choose a file limit between 1 and 10,000, or no limit", 400, "INVALID_LIMIT");
  }
  const normalized = sharePath(relativePath);
  if (!normalized) throw new AppError("Upload links can't be made for the root folder; choose a folder inside it", 400, "ROOT_SHARE");
  const candidate = await safeResolve(normalized, { followSymlink: false });
  const stat = await fs.lstat(candidate, { bigint: true });
  if (!stat.isDirectory()) throw new AppError("Upload links are for folders", 400, "UNSUPPORTED_SHARE");
  if ((await fs.realpath(candidate)) !== candidate) throw new AppError("Choose the folder at its real location, not through a linked folder", 400, "UNSUPPORTED_SHARE");
  const now = Date.now();
  const share: UploadShare = {
    id: crypto.randomBytes(12).toString("base64url"),
    path: normalized,
    name: path.posix.basename(normalized),
    type: "directory",
    dev: String(stat.dev),
    ino: String(stat.ino),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    maxDownloads: null,
    downloads: 0,
    kind: "upload",
    maxBytes,
    maxFiles,
    uploadedBytes: 0,
    uploadedFiles: 0,
    ...(passwordHash ? { passwordHash } : {}),
  };
  return mutate(async (shares) => ({ shares: [...shares, share], result: toLink(share) }));
}

// Space and files promised to uploads in progress, per link, so uploads at the same time can't
// together go past a link's limits.
const uploadsInProgress = new Map<string, { bytes: number; files: number }>();

export function uploadRoom(share: UploadShare) {
  const pending = uploadsInProgress.get(share.id) ?? { bytes: 0, files: 0 };
  return {
    bytes: Math.max(0, share.maxBytes - share.uploadedBytes - pending.bytes),
    // "No limit" still means at most MAX_UPLOAD_LINK_FILES, so a link can't fill a folder with entries.
    files: Math.max(0, (share.maxFiles ?? MAX_UPLOAD_LINK_FILES) - share.uploadedFiles - pending.files),
  };
}

/** Bytes promised to all uploads through links that are still in progress. */
export function bytesInProgress() {
  let total = 0;
  for (const pending of uploadsInProgress.values()) total += pending.bytes;
  return total;
}

/**
 * Promises room for one file of up to `bytes` through an upload link, or refuses if the link has no
 * room left. Returns a function that settles it with the bytes actually saved (or nothing, if the
 * upload failed and the room goes back).
 */
export async function reserveUpload(id: string, bytes: number) {
  await mutate(async (shares) => {
    const share = shares.find((item) => item.id === id);
    if (!share || !isUploadShare(share)) throw new AppError("This link isn't available", 404, "NOT_FOUND");
    const room = uploadRoom(share);
    if (room.files === 0) throw new AppError("This link has taken all the files it allows", 409, "UPLOAD_LINK_FULL");
    if (bytes > room.bytes) throw new AppError(room.bytes ? "This file is larger than the room left on this link" : "This link has no room left", 413, "UPLOAD_LINK_FULL");
    const pending = uploadsInProgress.get(id) ?? { bytes: 0, files: 0 };
    uploadsInProgress.set(id, { bytes: pending.bytes + bytes, files: pending.files + 1 });
    return { shares, result: undefined };
  });
  let settled = false;
  return async (saved?: number) => {
    if (settled) return;
    settled = true;
    await mutate(async (shares) => {
      const pending = uploadsInProgress.get(id);
      if (pending) {
        const next = { bytes: pending.bytes - bytes, files: pending.files - 1 };
        if (next.files <= 0) uploadsInProgress.delete(id);
        else uploadsInProgress.set(id, next);
      }
      if (saved === undefined) return { shares, result: undefined };
      return {
        shares: shares.map((item) => (item.id === id && isUploadShare(item) ? { ...item, uploadedBytes: item.uploadedBytes + saved, uploadedFiles: item.uploadedFiles + 1 } : item)),
        result: undefined,
      };
    });
  };
}

export async function listShares(): Promise<ShareLink[]> {
  return (await readShares()).filter((share) => isActive(share)).map(toLink).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ShareChanges = { hours?: unknown; maxDownloads?: unknown; maxBytes?: unknown; maxFiles?: unknown; password?: unknown };

/**
 * Changes a link in place: its expiry (from now), its download limit, an upload link's size and file
 * limits, or its password (a new one, or null to remove it). A new or removed password ends any
 * unlocks already given, since they're bound to the password. Limits can't go below what's been used.
 * Returns the updated link and what changed.
 */
export async function updateShare(id: string, changes: ShareChanges) {
  requireSharing();
  const hours = changes.hours === undefined ? undefined : Number(changes.hours);
  if (hours !== undefined && (!Number.isInteger(hours) || hours < 1 || hours > MAX_SHARE_HOURS)) throw new AppError("Links can last from 1 hour to 30 days", 400, "INVALID_EXPIRY");
  const limit = (value: unknown) => (value === null ? null : Number(value));
  const passwordHash = changes.password === undefined || changes.password === null ? changes.password : await linkPasswordHash(changes.password);
  if (passwordHash === undefined && typeof changes.password === "string") throw new AppError("Enter a password, or remove it", 400, "INVALID_PASSWORD");
  return mutate(async (shares) => {
    const share = shares.find((item) => item.id === id);
    if (!share) throw new AppError("That link no longer exists", 404, "NOT_FOUND");
    const next: StoredShare = { ...share };
    const changed: string[] = [];
    if (hours !== undefined) {
      next.expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
      changed.push("expiry");
    }
    if (changes.maxDownloads !== undefined) {
      if (isUploadShare(share)) throw new AppError("Upload links don't have a download limit", 400, "INVALID_LIMIT");
      const maxDownloads = limit(changes.maxDownloads);
      if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > MAX_SHARE_DOWNLOADS)) throw new AppError("Choose a download limit between 1 and 1,000, or no limit", 400, "INVALID_LIMIT");
      if (maxDownloads !== null && maxDownloads <= share.downloads) throw new AppError(`This link has already been downloaded ${share.downloads} ${share.downloads === 1 ? "time" : "times"}; choose a higher limit`, 400, "INVALID_LIMIT");
      next.maxDownloads = maxDownloads;
      changed.push("download limit");
    }
    if (changes.maxBytes !== undefined || changes.maxFiles !== undefined) {
      if (!isUploadShare(share)) throw new AppError("Only upload links have size and file limits", 400, "INVALID_LIMIT");
      if (changes.maxBytes !== undefined) {
        const maxBytes = Number(changes.maxBytes);
        if (!Number.isInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > MAX_UPLOAD_LINK_BYTES) throw new AppError("Choose a total upload size between 1 MB and 1 TB", 400, "INVALID_LIMIT");
        if (maxBytes < share.uploadedBytes) throw new AppError("This link has already received more than that", 400, "INVALID_LIMIT");
        (next as UploadShare).maxBytes = maxBytes;
        changed.push("size limit");
      }
      if (changes.maxFiles !== undefined) {
        const maxFiles = limit(changes.maxFiles);
        if (maxFiles !== null && (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_UPLOAD_LINK_FILES)) throw new AppError("Choose a file limit between 1 and 10,000, or no limit", 400, "INVALID_LIMIT");
        if (maxFiles !== null && maxFiles < share.uploadedFiles) throw new AppError(`This link has already received ${share.uploadedFiles} files; choose a higher limit`, 400, "INVALID_LIMIT");
        (next as UploadShare).maxFiles = maxFiles;
        changed.push("file limit");
      }
    }
    if (passwordHash === null) {
      if (share.passwordHash) changed.push("password removed");
      delete next.passwordHash;
    } else if (passwordHash) {
      changed.push(share.passwordHash ? "password changed" : "password added");
      next.passwordHash = passwordHash;
    }
    if (!changed.length) throw new AppError("Nothing to change", 400, "NO_CHANGES");
    return { shares: shares.map((item) => (item.id === id ? next : item)), result: { link: toLink(next), changed } };
  });
}

export async function revokeShare(id: string) {
  return mutate(async (shares) => {
    if (!shares.some((share) => share.id === id)) throw new AppError("That link no longer exists", 404, "NOT_FOUND");
    return { shares: shares.filter((share) => share.id !== id), result: undefined };
  });
}

/**
 * Keeps links pointing at items that are renamed or moved; links to deleted items are revoked.
 * Returns the ids of revoked links.
 *
 * A move between filesystems copies items, so `copies` maps each original that was copied (by device
 * and inode) to its copy. Links to those follow the copy; links to anything not copied stay where
 * they are, since that item is still there. The mapping comes from the copy itself, never from
 * looking the new path up, so nothing swapped in at that path can take a link over.
 */
export async function rewriteSharePaths(changes: Array<{ from: string; to?: string }>, copies?: CopiedItems) {
  const normalized = changes.map((change) => ({ from: sharePath(change.from), to: change.to === undefined ? undefined : sharePath(change.to) }));
  return mutate(async (shares) => {
    const revoked: string[] = [];
    const updated = shares.flatMap((share) => {
      const change = normalized.find((item) => item.from && (share.path === item.from || share.path.startsWith(`${item.from}/`)));
      if (!change) return [share];
      if (change.to === undefined) {
        revoked.push(share.id);
        return [];
      }
      const copy = copies?.get(`${share.dev}:${share.ino}`);
      if (copies && !copy) return [share];
      const nextPath = [change.to, share.path.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/");
      return [{ ...share, ...copy, path: nextPath, name: path.posix.basename(nextPath) }];
    });
    return { shares: updated, result: revoked };
  });
}

/** Returns the active share a public token refers to, or null for anything else. */
export async function resolveShareToken(token: string) {
  if (!config.sharingEnabled || token.length > 200) return null;
  const [id, supplied, extra] = token.split(".");
  if (extra !== undefined || !id || !supplied || !ID_PATTERN.test(id)) return null;
  const expected = Buffer.from(signatureFor(id));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const share = (await readShares()).find((item) => item.id === id);
    return share && isActive(share) ? share : null;
  } catch (error) {
    // A damaged state file makes links unavailable rather than turning every visit into an error.
    console.error(error);
    return null;
  }
}

/**
 * Opens the shared item exactly where and as it was shared: no symlinked path component, the same
 * device and inode, the same type, and not reserved. Returns null for anything else. Special files
 * such as FIFOs are opened without blocking and then refused.
 */
export async function openSharedItem(share: StoredShare) {
  const root = await ensureRoot();
  const expected = path.join(root, ...share.path.split("/"));
  let candidate: string;
  try {
    candidate = await safeResolve(share.path, { followSymlink: false });
  } catch {
    return null;
  }
  if (candidate !== expected) return null;
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (share.type === "directory" ? constants.O_DIRECTORY : 0);
  const handle = await fs.open(candidate, flags).catch(() => null);
  if (!handle) return null;
  try {
    const { openedPath, stat } = await verifyFileHandleWithinRoot(handle, candidate);
    const identity = await handle.stat({ bigint: true });
    const isReserved = await reservedPathCheck();
    const sameItem = openedPath === expected && String(identity.dev) === share.dev && String(identity.ino) === share.ino;
    const sameType = share.type === "directory" ? stat.isDirectory() : stat.isFile();
    if (!sameItem || !sameType || isReserved(openedPath)) throw new Error("Shared item changed");
    return { handle, openedPath, stat };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

/**
 * Opens an upload link's folder exactly as it was shared, as an anchored folder new files are created
 * in. Null if it moved, changed, or is no longer a folder.
 */
export async function openUploadFolder(share: UploadShare): Promise<AnchoredDirectory | null> {
  const opened = await openSharedItem(share);
  if (!opened) return null;
  if (!opened.stat.isDirectory()) {
    await opened.handle.close().catch(() => undefined);
    return null;
  }
  return { handle: opened.handle, base: process.platform === "linux" ? `/proc/self/fd/${opened.handle.fd}` : opened.openedPath, real: opened.openedPath, stat: opened.stat };
}

/** Counts a download, refusing it if the link expired or ran out in the meantime. */
export async function recordShareDownload(id: string) {
  return mutate(async (shares) => {
    const share = shares.find((item) => item.id === id);
    if (!share || isUploadShare(share)) return { shares, result: false };
    return { shares: shares.map((item) => (item.id === id ? { ...item, downloads: item.downloads + 1 } : item)), result: true };
  });
}
