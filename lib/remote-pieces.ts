import crypto from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, Stats } from "ssh2";
import type { Session } from "./auth";
import { config } from "./config";
import { AppError } from "./http";
import { remoteExists, remoteName, remotePath, sftpCall, withSftp } from "./sftp";

// Large files uploaded to another server in pieces, each its own request, so none is bigger than a
// proxy in front of FilesDude allows and a dropped connection carries on where it stopped. The pieces
// are written in order into a hidden temporary file in the folder on that server, which is renamed
// to a name nothing has ("name (1).ext") once complete, and removed if the upload is given up.
const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_UPLOADS = 4;
const IDLE_MS = 30 * 60_000;

type RemoteUpload = {
  id: string;
  accountKey: string;
  version: number;
  connection: string;
  /** The folder on the server (relative to its starting folder, as given) and the paths used there. */
  folder: string;
  directory: string;
  temporary: string;
  name: string;
  size: number;
  received: number;
  busy: boolean;
  lastActivity: number;
  /** Stops the piece being received (to cancel while one is under way). */
  stopPiece?: () => void;
  cancelRequested?: boolean;
};

// A piece that makes no progress for this long is given up: a server that stopped acknowledging
// writes is disconnected; a browser that stopped sending just loses the piece.
const PIECE_STALL_MS = 60_000;
const serverStalled = () => new AppError("The server stopped responding", 504, "REMOTE_STALLED");

const uploads = new Map<string, RemoteUpload>();
let starting = 0;
let sweeper: NodeJS.Timeout | null = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const upload of uploads.values()) if (!upload.busy && now - upload.lastActivity > IDLE_MS) void discard(upload);
    if (!uploads.size && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  sweeper.unref();
}

function find(session: Session, id: unknown) {
  const upload = typeof id === "string" ? uploads.get(id) : undefined;
  if (!upload || upload.accountKey !== session.accountKey || upload.version !== session.credentialsVersion) throw new AppError("That upload has expired or was cancelled. Start it again.", 404, "UPLOAD_NOT_FOUND");
  return upload;
}

async function discard(upload: RemoteUpload) {
  if (!uploads.delete(upload.id)) return;
  await withSftp(upload.connection, (sftp) => sftpCall<void>((done) => sftp.unlink(upload.temporary, done))).catch(() => undefined);
}

// Puts the finished file at a name nothing has, never over something: with the OpenSSH hard-link
// extension where the server has it (which fails if the name is taken), otherwise by renaming.
async function placeRemote(sftp: SFTPWrapper, directory: string, temporary: string, name: string) {
  const extension = path.posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const hardLinks = (sftp as unknown as { _extensions?: Record<string, string> })._extensions?.["hardlink@openssh.com"] === "1";
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = index ? `${stem} (${index})${extension}` : name;
    const target = path.posix.join(directory, candidate);
    if (await remoteExists(sftp, target)) continue;
    if (!hardLinks) {
      await sftpCall<void>((done) => sftp.rename(temporary, target, done));
      return candidate;
    }
    try {
      await sftpCall<void>((done) => sftp.ext_openssh_hardlink(temporary, target, done));
    } catch (error) {
      // Taken in the meantime: try the next name.
      if (await remoteExists(sftp, target)) continue;
      throw error;
    }
    await sftpCall<void>((done) => sftp.unlink(temporary, done)).catch(() => undefined);
    return candidate;
  }
  throw new AppError("Unable to choose an available name on the server", 409);
}

export async function startRemoteUpload(session: Session, connection: string, folder: string, rawName: unknown, rawSize: unknown) {
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 1) throw new AppError("The file's size is invalid", 400, "INVALID_SIZE");
  if (size > config.maxUploadBytes) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
  const name = remoteName(typeof rawName === "string" ? rawName.split(/[\\/]/).pop() : rawName);
  if (uploads.size + starting >= MAX_UPLOADS) throw new AppError(`At most ${MAX_UPLOADS} large uploads to other servers can run at once`, 429, "TOO_MANY_UPLOADS");
  starting += 1;
  try {
    return await withSftp(connection, async (sftp, root) => {
      const directory = remotePath(root, folder);
      const stats = await sftpCall<Stats>((done) => sftp.stat(directory, done));
      if (!stats.isDirectory()) throw new AppError("Upload destination is not a folder", 400, "NOT_A_DIRECTORY");
      const temporary = path.posix.join(directory, `.filesdude-upload-${crypto.randomBytes(9).toString("base64url")}`);
      const handle = await sftpCall<Buffer>((done) => sftp.open(temporary, "wx", { mode: 0o644 }, done));
      await sftpCall<void>((done) => sftp.close(handle, done));
      const upload: RemoteUpload = { id: crypto.randomBytes(18).toString("base64url"), accountKey: session.accountKey, version: session.credentialsVersion, connection, folder, directory, temporary, name, size, received: 0, busy: false, lastActivity: Date.now() };
      uploads.set(upload.id, upload);
      startSweeper();
      return { id: upload.id, chunkBytes: CHUNK_BYTES };
    });
  } finally {
    starting -= 1;
  }
}

export function remoteUploadStatus(session: Session, id: unknown) {
  const upload = find(session, id);
  return { received: upload.received, size: upload.size };
}

/**
 * Writes the next piece, which must start where the last one ended. A piece that fails part-way is
 * cut back off the temporary file, so the upload can carry on from the same point.
 */
export async function appendRemoteChunk(session: Session, id: unknown, rawOffset: unknown, declaredLength: number | null, body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  const upload = find(session, id);
  const offset = Number(rawOffset);
  if (upload.busy) throw new AppError("Another piece of this upload is still being received", 409, "UPLOAD_BUSY");
  if (offset !== upload.received) throw Object.assign(new AppError("That piece isn't the next one", 409, "WRONG_OFFSET"), { received: upload.received });
  if (declaredLength !== null && (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_CHUNK_BYTES)) throw new AppError("A piece of an upload must be between 1 byte and 64 MB", 413, "CHUNK_TOO_LARGE");
  if (declaredLength !== null && offset + declaredLength > upload.size) throw new AppError("That piece goes past the end of the file", 400, "CHUNK_TOO_LARGE");
  const limit = declaredLength ?? Math.min(MAX_CHUNK_BYTES, upload.size - offset);
  if (!body) throw new AppError("The piece is missing", 400, "INVALID_UPLOAD");
  upload.busy = true;
  let written = 0;
  const stop = new AbortController();
  upload.stopPiece = () => stop.abort();
  try {
    await withSftp(upload.connection, async (sftp) => {
      let lastProgress = Date.now();
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          lastProgress = Date.now();
          done(written > limit ? new AppError(declaredLength === null ? "The piece is too large" : "The piece is larger than it said", 400, "INVALID_UPLOAD") : null, chunk);
        },
      });
      // Opened here (with a time limit) and handed to the stream, so the stream doesn't open it again
      // or change its mode: the file keeps the 0644 it was created with.
      const handle = await sftpCall<Buffer>((done) => sftp.open(upload.temporary, "r+", done));
      const target = sftp.createWriteStream(upload.temporary, { handle, start: offset, autoClose: true } as never);
      let failure: AppError | null = null;
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgress < PIECE_STALL_MS) return;
        // Data waiting to be written means the server stopped taking it; otherwise the browser stopped.
        failure = target.writableLength > 0 ? serverStalled() : new AppError("The piece stopped arriving", 408, "UPLOAD_STALLED");
        stop.abort();
      }, 5_000);
      try {
        await pipeline(Readable.fromWeb(body as never, { signal: AbortSignal.any([signal, stop.signal]) }), meter, target);
        // The server has the piece once the stream has closed its handle; one that never confirms that
        // has stopped responding.
        await new Promise<void>((resolve, reject) => {
          if (target.closed) return resolve();
          const timer = setTimeout(() => reject(serverStalled()), PIECE_STALL_MS);
          const settle = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
          target.once("close", () => settle());
          target.once("error", settle);
          stop.signal.addEventListener("abort", () => settle(new AppError("The upload was cancelled", 400, "UPLOAD_ABORTED")), { once: true });
        });
      } catch (error) {
        target.destroy();
        if (!(failure && (failure as AppError).code === "REMOTE_STALLED")) {
          await sftpCall<void>((done) => sftp.setstat(upload.temporary, { size: upload.received } as never, done)).catch(() => undefined);
        }
        throw failure ?? error;
      } finally {
        clearInterval(watchdog);
      }
    });
    if (declaredLength !== null ? written !== declaredLength : written === 0) {
      await withSftp(upload.connection, (sftp) => sftpCall<void>((done) => sftp.setstat(upload.temporary, { size: upload.received } as never, done))).catch(() => undefined);
      throw new AppError("The piece ended early", 400, "INVALID_UPLOAD");
    }
    upload.received += written;
    return { received: upload.received, size: upload.size };
  } finally {
    upload.busy = false;
    upload.stopPiece = undefined;
    upload.lastActivity = Date.now();
    // Cancelled while this piece was arriving: removed now that it has stopped.
    if (upload.cancelRequested) await discard(upload);
  }
}

/** Gives a complete upload its name on the server; a number is added if the name is taken. */
export async function finishRemoteUpload(session: Session, id: unknown) {
  const upload = find(session, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  if (upload.received !== upload.size) throw Object.assign(new AppError("The upload isn't complete yet", 409, "UPLOAD_INCOMPLETE"), { received: upload.received });
  upload.busy = true;
  try {
    const chosen = await withSftp(upload.connection, async (sftp) => {
      const stats = await sftpCall<Stats>((done) => sftp.lstat(upload.temporary, done));
      if (!stats.isFile() || Number(stats.size) !== upload.size) throw new AppError("The file on the server isn't the one uploaded; upload it again", 409, "REMOTE_CHANGED");
      return placeRemote(sftp, upload.directory, upload.temporary, upload.name);
    });
    uploads.delete(upload.id);
    return { connection: upload.connection, folder: upload.folder, name: chosen, bytes: upload.size };
  } finally {
    upload.busy = false;
  }
}

export async function cancelRemoteUpload(session: Session, id: unknown) {
  const upload = find(session, id);
  // A piece under way is stopped, and the upload removed once it has.
  if (upload.busy) {
    if (upload.stopPiece) {
      upload.cancelRequested = true;
      upload.stopPiece();
      return;
    }
    throw new AppError("The upload is being finished", 409, "UPLOAD_BUSY");
  }
  await discard(upload);
}

/**
 * Gives up uploads to a server that was removed or changed, straight away; their temporary files are
 * removed in the background, so an unreachable server doesn't hold up the change.
 */
export function cancelConnectionUploads(connection: string) {
  for (const upload of [...uploads.values()]) {
    if (upload.connection !== connection) continue;
    upload.stopPiece?.();
    void discard(upload);
  }
}
