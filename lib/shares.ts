import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { ensureRoot, normalizeRelative, safeResolve, verifyFileHandleWithinRoot } from "./files";
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
}

export const MAX_SHARE_HOURS = 30 * 24;
const MAX_SHARE_DOWNLOADS = 1_000;
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

function toLink(share: StoredShare): ShareLink {
  return { ...share, url: `/s/${share.id}.${signatureFor(share.id)}` };
}

async function readShares(): Promise<StoredShare[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(sharesFile(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredShare => Boolean(item) && typeof item.id === "string" && ID_PATTERN.test(item.id)
      && typeof item.path === "string" && typeof item.name === "string" && (item.type === "file" || item.type === "directory")
      && typeof item.dev === "string" && typeof item.ino === "string"
      && typeof item.createdAt === "string" && typeof item.expiresAt === "string" && Number.isInteger(item.downloads)
      && (item.maxDownloads === null || Number.isInteger(item.maxDownloads)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw new AppError("Shared links data is corrupted", 500, "SHARES_CORRUPT");
    throw error;
  }
}

async function writeShares(shares: StoredShare[]) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `shares-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(shares, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, sharesFile());
}

// Serializes read-modify-write cycles; expired and used-up links are dropped on every write.
function mutate<T>(operation: (shares: StoredShare[]) => Promise<{ shares: StoredShare[]; result: T }>) {
  const run = async () => {
    const current = await readShares();
    const { shares, result } = await operation(current.filter((share) => isActive(share)));
    await writeShares(shares);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function requireSharing() {
  if (!config.sharingEnabled) throw new AppError("Sharing is turned off on this server", 403, "SHARING_DISABLED");
}

export async function createShare(relativePath: string, hours: number, maxDownloads: number | null): Promise<ShareLink> {
  requireSharing();
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
  };
  return mutate(async (shares) => ({ shares: [...shares, share], result: toLink(share) }));
}

export async function listShares(): Promise<ShareLink[]> {
  return (await readShares()).filter((share) => isActive(share)).map(toLink).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
 */
export async function rewriteSharePaths(changes: Array<{ from: string; to?: string }>) {
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
      const nextPath = [change.to, share.path.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/");
      return [{ ...share, path: nextPath, name: path.posix.basename(nextPath) }];
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

/** Counts a download, refusing it if the link expired or ran out in the meantime. */
export async function recordShareDownload(id: string) {
  return mutate(async (shares) => {
    const share = shares.find((item) => item.id === id);
    if (!share) return { shares, result: false };
    return { shares: shares.map((item) => (item.id === id ? { ...item, downloads: item.downloads + 1 } : item)), result: true };
  });
}
