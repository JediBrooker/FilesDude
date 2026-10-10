import crypto from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Session } from "./auth";
import { config } from "./config";
import { forgetCopies, recordCopy } from "./copy-journal";
import { audit } from "./audit";
import { acquireFilesystemLock, identityOf, inside, isReservedLocation, placeEntry, relativeFromAbsolute, removeCreated, safeResolve, verifyFileHandleWithinRoot } from "./files";
import { AppError } from "./http";
import { claimLinkSlot } from "./link-slots";
import { bytesInProgress as linkBytesInProgress, openUploadFolder, reserveUpload, type UploadShare } from "./shares";
import type { UploadDestination } from "./upload-destination";
import { addressGroup, applyOwnership, publicName, reservePublicTarget, reserveTarget, uploadName, withPublicNames } from "./upload-target";

// Large files are uploaded in pieces, each its own request, so no request is larger than a proxy in
// front of FilesDude allows (Cloudflare's is 100 MB) and an interrupted upload carries on where it
// stopped. The pieces are written in order into a visible "name (uploading)" placeholder, journaled
// like a copy's so a restart doesn't leave it behind; once complete it's given its real name.
export const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_PER_ACCOUNT = 4;
const MAX_UPLOADS = 32;
// An upload nothing has been sent to for this long is cancelled and its placeholder removed.
const IDLE_MS = 30 * 60_000;

// Uploads through upload links come from strangers, so they get less: a few at a time per link and
// per address, a shorter idle time, a deadline (a minute plus the file at a slow 64 KB/s), and the
// disk always keeps some space free.
const LINK_IDLE_MS = 5 * 60_000;
const PIECE_IDLE_MS = 60_000;
const SLOWEST_BYTES_PER_SECOND = 64 * 1024;
const LINK_KEEP_FREE_BYTES = 2 * 1024 ** 3;
const MIN_FILE_COST = 4096;

/** Who an upload belongs to: the session that started it, or an upload link and its sender. */
export type UploadOwner =
  | { kind: "account"; accountKey: string; username: string; version: number; role: Session["role"]; root: string }
  | { kind: "link"; shareId: string; group: string };

export const accountOwner = (session: Session): UploadOwner => ({ kind: "account", accountKey: session.accountKey, username: session.username, version: session.credentialsVersion, role: session.role, root: session.root });

// Any change to an account (folder, role, password) ends the uploads it started.
function sameOwner(a: UploadOwner, b: UploadOwner) {
  if (a.kind === "account" && b.kind === "account") return a.accountKey === b.accountKey && a.version === b.version && a.role === b.role && a.root === b.root;
  return a.kind === "link" && b.kind === "link" && a.shareId === b.shareId;
}

type PieceDestination = Pick<UploadDestination, "into" | "directory" | "ownership" | "batch" | "close">;

type ChunkedUpload = {
  id: string;
  owner: UploadOwner;
  destination: PieceDestination;
  /** Upload links: what the sender called themselves, and the link's room to give back or keep. */
  from?: string;
  settle?: (saved?: number) => Promise<void>;
  deadline: number | null;
  releaseSlot?: () => void;
  startedAt: number;
  /** Set the moment it's discarded, so a finish already under way doesn't place it. */
  discarded: boolean;
  name: string;
  temporary: string;
  handle: FileHandle;
  identity: string;
  journalId: string;
  size: number;
  received: number;
  busy: boolean;
  /** A finish is under way: it's left to complete rather than discarded. */
  finishing: boolean;
  /** Bytes of the piece being received, not yet counted in `received`. */
  inFlight: number;
  lastActivity: number;
};

const uploads = new Map<string, ChunkedUpload>();
// Uploads being started, counted towards the limit on uploads before anything is waited on.
let starting = 0;
let sweeper: NodeJS.Timeout | null = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const upload of uploads.values()) if (expired(upload, now)) void discard(upload, "abandoned").catch((error: unknown) => console.error("Could not remove an abandoned upload", error));
    if (!uploads.size && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  sweeper.unref();
}

function placeholderName(name: string) {
  const suffix = " (uploading)";
  const characters = Array.from(name);
  while (Buffer.byteLength(characters.join("") + suffix) > 255) characters.pop();
  return characters.join("") + suffix;
}

function expired(upload: ChunkedUpload, now = Date.now()) {
  // A finish in progress is left to complete. A piece in progress isn't protected: discarding closes
  // the file, so its write fails and nothing is left behind.
  if (upload.finishing) return false;
  if (upload.deadline !== null && now > upload.deadline) return true;
  if (upload.owner.kind === "link") {
    // A stranger's upload has to keep up a slow but steady pace after its first two minutes, so it
    // can't hold the link's room with a byte now and then (the piece arriving counts).
    const elapsed = now - upload.startedAt - 120_000;
    if (elapsed > 0 && upload.received + upload.inFlight < (elapsed / 1000) * SLOWEST_BYTES_PER_SECOND) return true;
  }
  return now - upload.lastActivity > (upload.owner.kind === "link" ? LINK_IDLE_MS : IDLE_MS);
}

function find(owner: UploadOwner, id: unknown) {
  const upload = typeof id === "string" ? uploads.get(id) : undefined;
  // Someone else's upload is as unknown as one that never existed, and so is one started before the
  // account was changed, or one past its time.
  if (!upload || !sameOwner(upload.owner, owner) || (upload.deadline !== null && Date.now() > upload.deadline)) throw new AppError("That upload has expired or was cancelled. Start it again.", 404, "UPLOAD_NOT_FOUND");
  return upload;
}

async function discard(upload: ChunkedUpload, reason: "cancelled" | "abandoned" | "account changed" | "link revoked") {
  if (!uploads.delete(upload.id)) return;
  upload.discarded = true;
  upload.releaseSlot?.();
  const release = await acquireFilesystemLock();
  try {
    // Under the lock, after any finish already placing the file: if it got there first, the room it
    // used stays counted and there's no placeholder left to remove.
    await upload.settle?.().catch(() => undefined);
    await upload.handle.close().catch(() => undefined);
    await removeCreated(upload.destination.into, upload.temporary, upload.identity).catch(() => undefined);
  } finally {
    release();
  }
  await forgetCopies([upload.journalId]).catch((error: unknown) => console.error("Could not update the copy journal", error));
  await upload.destination.close();
  // A stranger giving up on an upload link isn't worth recording; an account's upload is.
  if (upload.owner.kind === "account") await audit("fs.upload_discarded", { username: upload.owner.username, directory: upload.destination.directory, name: upload.name, received: upload.received, size: upload.size, reason });
}

/** Creates the journaled placeholder and records the upload. */
async function begin(owner: UploadOwner, destination: PieceDestination, name: string, size: number, extra: Pick<ChunkedUpload, "from" | "settle" | "deadline" | "releaseSlot">) {
  const placeholder = owner.kind === "link"
    ? await reservePublicTarget(destination.into, placeholderName(name))
    : await reserveTarget(destination.into, destination.directory, placeholderName(name));
  try {
    // The placeholder stays the service's own (0600) until it's complete, as copies' do, so recovery
    // after a restart can tell it apart; the file gets its mode and owner then.
    await placeholder.handle.chmod(0o600);
    const stat = await placeholder.handle.stat({ bigint: true });
    const journalId = crypto.randomUUID();
    await recordCopy({ id: journalId, directory: destination.into.real, name: placeholder.name, identity: identityOf(placeholder.created), birth: String(stat.birthtimeNs), startedAt: new Date().toISOString() });
    const upload: ChunkedUpload = {
      id: crypto.randomBytes(18).toString("base64url"),
      owner,
      destination,
      ...extra,
      name,
      temporary: placeholder.name,
      handle: placeholder.handle,
      identity: identityOf(placeholder.created),
      journalId,
      size,
      received: 0,
      busy: false,
      finishing: false,
      inFlight: 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      discarded: false,
    };
    uploads.set(upload.id, upload);
    startSweeper();
    return { id: upload.id, chunkBytes: CHUNK_BYTES };
  } catch (error) {
    await placeholder.handle.close().catch(() => undefined);
    await removeCreated(destination.into, placeholder.name, identityOf(placeholder.created)).catch(() => undefined);
    throw error;
  }
}

function checkSize(rawSize: unknown) {
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 1) throw new AppError("The file's size is invalid", 400, "INVALID_SIZE");
  if (size > config.maxUploadBytes) throw new AppError(`Files can be at most ${Math.floor(config.maxUploadBytes / 1024 ** 2).toLocaleString("en")} MB each`, 413, "UPLOAD_TOO_LARGE");
  return size;
}

// Free space on a folder's disk, less what uploads in progress have still to write: accounts' uploads
// in pieces, and everything promised to uploads through links (in pieces or not).
async function freeBytes(folder: PieceDestination["into"]) {
  const disk = await fsp.statfs(folder.base);
  // Link uploads in pieces are promised their whole size, but what they've written is already off
  // the free space, so it's added back.
  const linkPiecesWritten = [...uploads.values()].reduce((total, upload) => total + (upload.owner.kind === "link" ? upload.received : 0), 0);
  return Number(disk.bavail) * Number(disk.bsize) - accountBytesStillComing() - linkBytesInProgress() + linkPiecesWritten;
}

/** Space accounts' uploads in pieces have still to write. */
export const accountBytesStillComing = () => [...uploads.values()].reduce((total, upload) => total + (upload.owner.kind === "account" ? upload.size - upload.received : 0), 0);

/**
 * Starts uploading a file of `size` bytes into an opened destination, which this upload then owns
 * (and closes). Called with the filesystem lock held.
 */
export async function startChunkedUpload(session: Session, destination: UploadDestination, rawName: unknown, rawSize: unknown) {
  if (typeof rawName !== "string" || rawName.length > 1024) throw new AppError("An uploaded file has an invalid name", 400, "INVALID_NAME");
  const size = checkSize(rawSize);
  const name = uploadName(rawName);
  await safeResolve([destination.directory, name].filter(Boolean).join("/"), { mustExist: false });
  const owner = accountOwner(session);
  if ([...uploads.values()].filter((upload) => upload.owner.kind === "account" && upload.owner.accountKey === session.accountKey).length >= MAX_PER_ACCOUNT) throw new AppError(`At most ${MAX_PER_ACCOUNT} large uploads can run at once`, 429, "TOO_MANY_UPLOADS");
  if (uploads.size + starting >= MAX_UPLOADS) throw new AppError("The server is busy with other uploads. Try again in a minute.", 503, "BUSY");
  starting += 1;
  try {
    if ((await freeBytes(destination.into)) < size) throw new AppError("There isn't enough free space for this file", 507, "DISK_FULL");
    return await begin(owner, destination, name, size, { deadline: null });
  } finally {
    starting -= 1;
  }
}

/**
 * Starts uploading a file through an upload link: its room on the link is promised now and kept or
 * given back when it finishes. The link's folder is opened as it was shared.
 */
export async function startLinkUpload(share: UploadShare, address: string, rawName: unknown, rawSize: unknown, rawFrom: unknown) {
  if (typeof rawName !== "string" || rawName.length > 1024) throw new AppError("An uploaded file has an invalid name", 400, "INVALID_NAME");
  const size = checkSize(rawSize);
  const name = publicName(rawName);
  const from = typeof rawFrom === "string" ? rawFrom.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 64) : "";
  const owner: UploadOwner = { kind: "link", shareId: share.id, group: addressGroup(address) };
  // Every limit is checked and claimed before anything is waited on.
  if (uploads.size + starting >= MAX_UPLOADS) throw new AppError("The server is busy with other uploads. Try again in a minute.", 503, "BUSY");
  const releaseSlot = claimLinkSlot(share.id, address);
  starting += 1;
  let settle: ((saved?: number) => Promise<void>) | null = null;
  let folder: PieceDestination["into"] | null = null;
  try {
    settle = await reserveUpload(share.id, Math.max(size, MIN_FILE_COST));
    const release = await acquireFilesystemLock();
    try {
      folder = await openUploadFolder(share);
    } finally {
      release();
    }
    if (!folder) throw new AppError("This link is invalid, has expired, or the folder is no longer available.", 404, "NOT_FOUND");
    // This upload's own room is already counted among those in progress.
    if ((await freeBytes(folder)) < LINK_KEEP_FREE_BYTES) throw new AppError("The server doesn't have room for this file", 507, "DISK_FULL");
    const opened = folder;
    // When running as root, a stranger's file belongs to the folder's owner, like other new items.
    const ownership = typeof process.getuid === "function" && process.getuid() === 0 ? { uid: opened.stat.uid, gid: opened.stat.gid } : null;
    const destination: PieceDestination = { into: opened, directory: share.path, ownership, batch: undefined, close: async () => { await opened.handle.close().catch(() => undefined); } };
    return await begin(owner, destination, name, size, { from, settle, releaseSlot, deadline: Date.now() + 60_000 + (size / SLOWEST_BYTES_PER_SECOND) * 1000 });
  } catch (error) {
    await folder?.handle.close().catch(() => undefined);
    await settle?.().catch(() => undefined);
    releaseSlot();
    throw error;
  } finally {
    starting -= 1;
  }
}

export function chunkedUploadStatus(owner: UploadOwner, id: unknown) {
  const upload = find(owner, id);
  return { received: upload.received, size: upload.size };
}

/**
 * Writes the next piece of an upload, which must start where the last one ended. A piece that fails
 * part-way is taken back, so the upload can carry on from the same point.
 */
export async function appendChunk(owner: UploadOwner, id: unknown, rawOffset: unknown, declaredLength: number | null, body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  const upload = find(owner, id);
  const offset = Number(rawOffset);
  if (upload.busy) throw new AppError("Another piece of this upload is still being received", 409, "UPLOAD_BUSY");
  if (offset !== upload.received) throw Object.assign(new AppError("That piece isn't the next one", 409, "WRONG_OFFSET"), { received: upload.received });
  // A proxy may pass a piece on without its length; it's then held to the most a piece may be.
  if (declaredLength !== null && (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_CHUNK_BYTES)) throw new AppError("A piece of an upload must be between 1 byte and 64 MB", 413, "CHUNK_TOO_LARGE");
  if (declaredLength !== null && offset + declaredLength > upload.size) throw new AppError("That piece goes past the end of the file", 400, "CHUNK_TOO_LARGE");
  const limit = declaredLength ?? Math.min(MAX_CHUNK_BYTES, upload.size - offset);
  if (!body) throw new AppError("The piece is missing", 400, "INVALID_UPLOAD");
  upload.busy = true;
  let written = 0;
  // A piece that sends nothing for a minute is given up on, so it can't hold the upload open.
  const idle = new AbortController();
  let idleTimer = setTimeout(() => idle.abort(), PIECE_IDLE_MS);
  try {
    for await (const chunk of Readable.fromWeb(body as never, { signal: AbortSignal.any([signal, idle.signal]) }) as AsyncIterable<Buffer>) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), PIECE_IDLE_MS);
      if (upload.discarded) throw new AppError("That upload has expired or was cancelled. Start it again.", 404, "UPLOAD_NOT_FOUND");
      if (written + chunk.length > limit) throw new AppError(declaredLength === null ? "The piece is too large" : "The piece is larger than it said", 400, "INVALID_UPLOAD");
      let done = 0;
      while (done < chunk.length) {
        const { bytesWritten } = await upload.handle.write(chunk, done, chunk.length - done, offset + written + done);
        done += bytesWritten;
      }
      written += chunk.length;
      upload.inFlight = written;
      upload.lastActivity = Date.now();
    }
    if (declaredLength !== null ? written !== declaredLength : written === 0) throw new AppError("The piece ended early", 400, "INVALID_UPLOAD");
    upload.received += written;
    return { received: upload.received, size: upload.size };
  } catch (error) {
    await upload.handle.truncate(upload.received).catch(() => undefined);
    if (idle.signal.aborted) throw new AppError("The piece stopped arriving", 408, "UPLOAD_STALLED");
    throw error;
  } finally {
    clearTimeout(idleTimer);
    upload.inFlight = 0;
    upload.busy = false;
    upload.lastActivity = Date.now();
  }
}

/** Gives a complete upload its real name (a number is added if it's taken), mode, and owner. */
export async function finishChunkedUpload(owner: UploadOwner, id: unknown) {
  const upload = find(owner, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  if (upload.received !== upload.size) throw Object.assign(new AppError("The upload isn't complete yet", 409, "UPLOAD_INCOMPLETE"), { received: upload.received });
  upload.busy = true;
  upload.finishing = true;
  const { into, directory, ownership } = upload.destination;
  const release = await acquireFilesystemLock();
  try {
    // Discarded while this waited (cancelled, revoked, or out of time): it isn't placed.
    if (upload.discarded || uploads.get(upload.id) !== upload) throw new AppError("That upload has expired or was cancelled. Start it again.", 404, "UPLOAD_NOT_FOUND");
    const current = await fsp.lstat(inside(into, upload.temporary)).catch(() => null);
    if (!current || identityOf(current) !== upload.identity) throw new AppError("The upload's placeholder was changed or removed", 409, "PATH_CHANGED");
    // The folder is used where it is now: it may have been moved or deleted since the upload began.
    const moved = () => new AppError("The folder this file was going to was moved or deleted. Upload it again.", 409, "PATH_CHANGED");
    const { openedPath } = await verifyFileHandleWithinRoot(into.handle, into.real).catch(() => { throw moved(); });
    if (relativeFromAbsolute(openedPath) !== directory || (await isReservedLocation(openedPath))) throw moved();
    // The mode and owner are set first, so a file never appears under its real name without them;
    // if that fails, the placeholder is the service's own again, for recovery to find.
    try {
      await upload.handle.chmod(0o640);
      await applyOwnership(upload.handle, ownership);
    } catch (error) {
      await upload.handle.chmod(0o600).catch(() => undefined);
      throw error;
    }
    let placed: string | null = null;
    const place = async (candidate: string) => {
      try {
        await placeEntry(into, upload.temporary, into, candidate);
        placed = candidate;
        return true;
      } catch (error) {
        if (!(error instanceof AppError && error.code === "NAME_CONFLICT")) throw error;
        return false;
      }
    };
    if (upload.owner.kind === "link") {
      // A stranger's file takes a free name without anything about the folder being looked up.
      await withPublicNames(into, upload.name, place);
    } else {
      const extension = path.extname(upload.name);
      const stem = extension ? upload.name.slice(0, -extension.length) : upload.name;
      for (let index = 0; index < 10_000 && !placed; index += 1) {
        const candidate = index === 0 ? upload.name : `${stem} (${index})${extension}`;
        await safeResolve([directory, candidate].filter(Boolean).join("/"), { mustExist: false });
        await place(candidate);
      }
    }
    if (!placed) throw new AppError("Unable to choose an available upload name", 409);
    // Only the file this upload wrote may end up under the new name.
    const result = await fsp.lstat(inside(into, placed));
    if (identityOf(result) !== upload.identity) {
      await fsp.unlink(inside(into, placed)).catch(() => undefined);
      throw new AppError("The upload's placeholder was changed or removed", 409, "PATH_CHANGED");
    }
    uploads.delete(upload.id);
    upload.releaseSlot?.();
    await upload.settle?.(Math.max(upload.size, MIN_FILE_COST)).catch((error: unknown) => console.error("Could not record an upload on its link", error));
    await upload.handle.close().catch(() => undefined);
    await forgetCopies([upload.journalId]).catch((error: unknown) => console.error("Could not update the copy journal", error));
    await upload.destination.close();
    return { name: placed as string, relative: [directory, placed].filter(Boolean).join("/"), bytes: upload.size, ownership, batch: upload.destination.batch, directory, from: upload.from };
  } catch (error) {
    upload.busy = false;
    upload.finishing = false;
    throw error;
  } finally {
    release();
  }
}

export async function cancelChunkedUpload(owner: UploadOwner, id: unknown) {
  const upload = find(owner, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  await discard(upload, "cancelled");
}

/** Cancels every upload an account has in progress (when it's deleted or its access changes). */
export async function cancelAccountUploads(accountKey: string) {
  for (const upload of [...uploads.values()]) if (upload.owner.kind === "account" && upload.owner.accountKey === accountKey) await discard(upload, "account changed").catch(() => undefined);
}

/** Cancels every upload in progress through an upload link (when it's revoked). */
export async function cancelLinkUploads(shareId: string) {
  for (const upload of [...uploads.values()]) if (upload.owner.kind === "link" && upload.owner.shareId === shareId) await discard(upload, "link revoked").catch(() => undefined);
}

