import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { normalizeRelative, safeResolve } from "./files";
import { AppError } from "./http";
import type { ShareLink } from "./types";

// A share link is /s/<id>.<signature>, where the signature is an HMAC of the id under the session
// secret. Only the id is stored, so the state file alone cannot be used to download anything, and
// rotating the session secret invalidates every link along with every session.
interface StoredShare {
  id: string;
  path: string;
  name: string;
  type: "file" | "directory";
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

function signatureFor(id: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(`filesdude-share:${id}`).digest("base64url");
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
  await fs.writeFile(temporary, `${JSON.stringify(shares, null, 2)}\n`, { mode: 0o600 });
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
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new AppError("The root folder can't be shared", 400, "ROOT_SHARE");
  const stat = await fs.stat(await safeResolve(normalized));
  if (!stat.isFile() && !stat.isDirectory()) throw new AppError("Only files and folders can be shared", 400, "UNSUPPORTED_SHARE");
  const now = Date.now();
  const share: StoredShare = {
    id: crypto.randomBytes(12).toString("base64url"),
    path: normalized,
    name: path.posix.basename(normalized),
    type: stat.isDirectory() ? "directory" : "file",
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

/** Keeps links pointing at items that are renamed or moved; links to deleted items are revoked. */
export async function rewriteSharePaths(changes: Array<{ from: string; to?: string }>) {
  const normalized = changes.map((change) => ({ from: normalizeRelative(change.from), to: change.to === undefined ? undefined : normalizeRelative(change.to) }));
  return mutate(async (shares) => ({
    shares: shares.flatMap((share) => {
      const change = normalized.find((item) => item.from && (share.path === item.from || share.path.startsWith(`${item.from}/`)));
      if (!change) return [share];
      if (change.to === undefined) return [];
      const nextPath = [change.to, share.path.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/");
      return [{ ...share, path: nextPath, name: path.posix.basename(nextPath) }];
    }),
    result: undefined,
  }));
}

/** Returns the active share a public token refers to, or null for anything else. */
export async function resolveShareToken(token: string) {
  if (!config.sharingEnabled || token.length > 200) return null;
  const [id, supplied, extra] = token.split(".");
  if (extra !== undefined || !id || !supplied || !ID_PATTERN.test(id)) return null;
  const expected = Buffer.from(signatureFor(id));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const share = (await readShares()).find((item) => item.id === id);
  return share && isActive(share) ? share : null;
}

/** Counts a download, refusing it if the link expired or ran out in the meantime. */
export async function recordShareDownload(id: string) {
  return mutate(async (shares) => {
    const share = shares.find((item) => item.id === id);
    if (!share) return { shares, result: false };
    return { shares: shares.map((item) => (item.id === id ? { ...item, downloads: item.downloads + 1 } : item)), result: true };
  });
}
