import crypto from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Stats } from "ssh2";
import type { Session } from "./auth";
import { config } from "./config";
import { AppError } from "./http";
import { availableRemoteName, remoteName, remotePath, sftpCall, withSftp } from "./sftp";

// Large files uploaded to another server in pieces, each its own request, so none is bigger than a
// proxy in front of FilesDude allows and a dropped connection carries on where it stopped. The pieces
// are written in order into a hidden temporary file in the folder on that server, which is renamed
// to a name nothing has ("name (1).ext") once complete, and removed if the upload is given up.
const CHUNK_BYTES = 32 * 1024 * 1024;
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
};

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
  try {
    await withSftp(upload.connection, async (sftp) => {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          done(written > limit ? new AppError(declaredLength === null ? "The piece is too large" : "The piece is larger than it said", 400, "INVALID_UPLOAD") : null, chunk);
        },
      });
      const target = sftp.createWriteStream(upload.temporary, { flags: "r+", start: offset });
      try {
        await pipeline(Readable.fromWeb(body as never, { signal }), meter, target);
        // The server has the piece once the stream has closed its handle.
        await new Promise<void>((resolve, reject) => {
          if (target.closed) return resolve();
          target.once("close", resolve);
          target.once("error", reject);
        });
      } catch (error) {
        target.destroy();
        await sftpCall<void>((done) => sftp.setstat(upload.temporary, { size: upload.received } as never, done)).catch(() => undefined);
        throw error;
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
    upload.lastActivity = Date.now();
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
      const name = await availableRemoteName(sftp, upload.directory, upload.name);
      await sftpCall<void>((done) => sftp.rename(upload.temporary, path.posix.join(upload.directory, name), done));
      return name;
    });
    uploads.delete(upload.id);
    return { connection: upload.connection, folder: upload.folder, name: chosen, bytes: upload.size };
  } finally {
    upload.busy = false;
  }
}

export async function cancelRemoteUpload(session: Session, id: unknown) {
  const upload = find(session, id);
  if (upload.busy) throw new AppError("A piece of this upload is still being received", 409, "UPLOAD_BUSY");
  await discard(upload);
}

/** Gives up uploads to a server that was removed or changed. */
export async function cancelConnectionUploads(connection: string) {
  for (const upload of [...uploads.values()]) if (upload.connection === connection) await discard(upload);
}
