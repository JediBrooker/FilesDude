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
import type { UploadDestination } from "./upload-destination";
import { applyOwnership, reserveTarget, uploadName } from "./upload-target";

// Large files are uploaded in pieces, each its own request, so no request is larger than a proxy in
// front of FilesDude allows (Cloudflare's is 100 MB) and an interrupted upload carries on where it
// stopped. The pieces are written in order into a visible "name (uploading)" placeholder, journaled
// like a copy's so a restart doesn't leave it behind; once complete it's given its real name.
export const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_PER_ACCOUNT = 4;
const MAX_UPLOADS = 32;
// An upload nothing has been sent to for this long is cancelled and its placeholder removed.
const IDLE_MS = 30 * 60_000;

type ChunkedUpload = {
  id: string;
  accountKey: string;
  username: string;
  /** The session it was started from: any change to the account (folder, role, password) ends it. */
  version: number;
  role: Session["role"];
  root: string;
  destination: UploadDestination;
  name: string;
  temporary: string;
  handle: FileHandle;
  identity: string;
  journalId: string;
  size: number;
  received: number;
  busy: boolean;
  lastActivity: number;
};

const uploads = new Map<string, ChunkedUpload>();
let sweeper: NodeJS.Timeout | null = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const upload of uploads.values()) if (!upload.busy && now - upload.lastActivity > IDLE_MS) void discard(upload, "abandoned").catch((error: unknown) => console.error("Could not remove an abandoned upload", error));
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

function find(session: Session, id: unknown) {
  const upload = typeof id === "string" ? uploads.get(id) : undefined;
  // Another account's upload is as unknown as one that never existed, and so is one started before
  // the account was changed.
  if (!upload || upload.accountKey !== session.accountKey || upload.version !== session.credentialsVersion || upload.role !== session.role || upload.root !== session.root) throw new AppError("That upload has expired or was cancelled. Start it again.", 404, "UPLOAD_NOT_FOUND");
  return upload;
}

async function discard(upload: ChunkedUpload, reason: "cancelled" | "abandoned" | "account changed") {
  if (!uploads.delete(upload.id)) return;
  await upload.handle.close().catch(() => undefined);
  const release = await acquireFilesystemLock();
  try {
    await removeCreated(upload.destination.into, upload.temporary, upload.identity).catch(() => undefined);
  } finally {
    release();
  }
  await forgetCopies([upload.journalId]).catch((error: unknown) => console.error("Could not update the copy journal", error));
  await upload.destination.close();
  await audit("fs.upload_discarded", { username: upload.username, directory: upload.destination.directory, name: upload.name, received: upload.received, size: upload.size, reason });
}

// Space still to be written by the uploads in progress.
const bytesStillComing = () => [...uploads.values()].reduce((total, upload) => total + upload.size - upload.received, 0);

/**
 * Starts uploading a file of `size` bytes into an opened destination, which this upload then owns
 * (and closes). Called with the filesystem lock held.
 */
export async function startChunkedUpload(session: Session, destination: UploadDestination, rawName: unknown, rawSize: unknown) {
  const size = Number(rawSize);
  if (typeof rawName !== "string" || rawName.length > 1024) throw new AppError("An uploaded file has an invalid name", 400, "INVALID_NAME");
  if (!Number.isSafeInteger(size) || size < 1) throw new AppError("The file's size is invalid", 400, "INVALID_SIZE");
  if (size > config.maxUploadBytes) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
  const name = uploadName(rawName);
  await safeResolve([destination.directory, name].filter(Boolean).join("/"), { mustExist: false });
  if ([...uploads.values()].filter((upload) => upload.accountKey === session.accountKey).length >= MAX_PER_ACCOUNT) throw new AppError(`At most ${MAX_PER_ACCOUNT} large uploads can run at once`, 429, "TOO_MANY_UPLOADS");
  if (uploads.size >= MAX_UPLOADS) throw new AppError("The server is busy with other uploads. Try again in a minute.", 503, "BUSY");
  const disk = await fsp.statfs(destination.into.base);
  if (Number(disk.bavail) * Number(disk.bsize) - bytesStillComing() < size) throw new AppError("There isn't enough free space for this file", 507, "DISK_FULL");

  const placeholder = await reserveTarget(destination.into, destination.directory, placeholderName(name));
  try {
    // The placeholder stays the service's own (0600) until it's complete, as copies' do, so recovery
    // after a restart can tell it apart; the file gets its mode and owner then.
    await placeholder.handle.chmod(0o600);
    const stat = await placeholder.handle.stat({ bigint: true });
    const journalId = crypto.randomUUID();
    await recordCopy({ id: journalId, directory: destination.into.real, name: placeholder.name, identity: identityOf(placeholder.created), birth: String(stat.birthtimeNs), startedAt: new Date().toISOString() });
    const upload: ChunkedUpload = {
      id: crypto.randomBytes(18).toString("base64url"),
      accountKey: session.accountKey,
      username: session.username,
      version: session.credentialsVersion,
      role: session.role,
      root: session.root,
      destination,
      name,
      temporary: placeholder.name,
      handle: placeholder.handle,
      identity: identityOf(placeholder.created),
      journalId,
      size,
      received: 0,
      busy: false,
      lastActivity: Date.now(),
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

export function chunkedUploadStatus(session: Session, id: unknown) {
  const upload = find(session, id);
  return { received: upload.received, size: upload.size };
}

/**
 * Writes the next piece of an upload, which must start where the last one ended. A piece that fails
 * part-way is taken back, so the upload can carry on from the same point.
 */
export async function appendChunk(session: Session, id: unknown, rawOffset: unknown, declaredLength: number | null, body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  const upload = find(session, id);
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
  try {
    for await (const chunk of Readable.fromWeb(body as never, { signal }) as AsyncIterable<Buffer>) {
      if (written + chunk.length > limit) throw new AppError(declaredLength === null ? "The piece is too large" : "The piece is larger than it said", 400, "INVALID_UPLOAD");
      let done = 0;
      while (done < chunk.length) {
        const { bytesWritten } = await upload.handle.write(chunk, done, chunk.length - done, offset + written + done);
        done += bytesWritten;
      }
      written += chunk.length;
    }
    if (declaredLength !== null ? written !== declaredLength : written === 0) throw new AppError("The piece ended early", 400, "INVALID_UPLOAD");
    upload.received += written;
    return { received: upload.received, size: upload.size };
  } catch (error) {
    await upload.handle.truncate(upload.received).catch(() => undefined);
    throw error;
  } finally {
    upload.busy = false;
    upload.lastActivity = Date.now();
  }
}

/** Gives a complete upload its real name (a number is added if it's taken), mode, and owner. */
export async function finishChunkedUpload(session: Session, id: unknown) {
  const upload = find(session, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  if (upload.received !== upload.size) throw Object.assign(new AppError("The upload isn't complete yet", 409, "UPLOAD_INCOMPLETE"), { received: upload.received });
  upload.busy = true;
  const { into, directory, ownership } = upload.destination;
  const release = await acquireFilesystemLock();
  try {
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
    const extension = path.extname(upload.name);
    const stem = extension ? upload.name.slice(0, -extension.length) : upload.name;
    let placed: string | null = null;
    for (let index = 0; index < 10_000 && !placed; index += 1) {
      const candidate = index === 0 ? upload.name : `${stem} (${index})${extension}`;
      await safeResolve([directory, candidate].filter(Boolean).join("/"), { mustExist: false });
      try {
        await placeEntry(into, upload.temporary, into, candidate);
        placed = candidate;
      } catch (error) {
        if (!(error instanceof AppError && error.code === "NAME_CONFLICT")) throw error;
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
    await upload.handle.close().catch(() => undefined);
    await forgetCopies([upload.journalId]).catch((error: unknown) => console.error("Could not update the copy journal", error));
    await upload.destination.close();
    return { relative: [directory, placed].filter(Boolean).join("/"), bytes: upload.size, ownership, batch: upload.destination.batch, directory };
  } catch (error) {
    upload.busy = false;
    throw error;
  } finally {
    release();
  }
}

export async function cancelChunkedUpload(session: Session, id: unknown) {
  const upload = find(session, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  await discard(upload, "cancelled");
}

/** Cancels every upload an account has in progress (when it's deleted or its access changes). */
export async function cancelAccountUploads(accountKey: string) {
  for (const upload of [...uploads.values()]) if (upload.accountKey === accountKey) await discard(upload, "account changed").catch(() => undefined);
}
