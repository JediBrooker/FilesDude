import type { Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/auth";
import { config } from "@/lib/config";
import { acquireFilesystemLock, removeIfSame, type AnchoredDirectory } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { bytesInProgress, isUnlocked, isUploadShare, openUploadFolder, reserveUpload, resolveShareToken, type UploadShare } from "@/lib/shares";
import { accountBytesStillComing } from "@/lib/chunked-uploads";
import { claimLinkSlot } from "@/lib/link-slots";
import { publicName, reservePublicTarget } from "@/lib/upload-target";
import { canChangeOwnership } from "@/lib/privileges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public and unauthenticated: one file per request, into the link's folder, within the link's limits.
// Uploads never replace anything and the response never says what's in the folder.
// An upload that sends nothing for this long is dropped, and every upload has a deadline (a minute
// plus its size at a slow 64 KB/s), so none can hold a slot forever.
const IDLE_MS = 60_000;
const SLOWEST_BYTES_PER_SECOND = 64 * 1024;
// Each file counts at least this much against a link, so tiny files can't be sent without end.
const MIN_FILE_COST = 4096;
// Uploads through links always leave this much space free on the disk.
const KEEP_FREE_BYTES = 2 * 1024 ** 3;
// Room for the multipart wrapping around the file in the request body.
const MULTIPART_ALLOWANCE = 64 * 1024;

const unavailable = () => new AppError("This link is invalid, has expired, or the folder is no longer available.", 404, "NOT_FOUND");

type Saved = { name: string; bytes: number; created: Stats; into: AnchoredDirectory };

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  let releaseSlot: (() => void) | null = null;
  let settle: ((saved?: number) => Promise<void>) | null = null;
  let folder: AnchoredDirectory | null = null;
  try {
    assertMutationRequest(request);
    const share = await resolveShareToken((await params).token);
    if (!share || !isUploadShare(share)) throw unavailable();
    if (!isUnlocked(share, request.headers.get("cookie"))) throw new AppError("This link needs its password. Reload the page and enter it.", 401, "PASSWORD_REQUIRED");
    const address = clientAddress(request);

    const declared = Number(request.headers.get("content-length"));
    if (!request.headers.get("content-length") || !Number.isInteger(declared) || declared <= 0) throw new AppError("The upload's size is missing", 411, "LENGTH_REQUIRED");
    if (declared > config.maxUploadBytes + MULTIPART_ALLOWANCE) throw new AppError(`Files can be at most ${Math.floor(config.maxUploadBytes / 1024 ** 2)} MB each`, 413, "UPLOAD_TOO_LARGE");
    if (!request.body) throw new AppError("Upload body is missing", 400);
    releaseSlot = claimLinkSlot(share.id, address);
    // The whole request is counted against the link while it uploads; only the file's bytes are kept.
    settle = await reserveUpload(share.id, Math.max(declared, MIN_FILE_COST));

    const saved = await receiveFile(request, share, declared, (opened) => { folder = opened; });
    await settle(Math.max(saved.bytes, MIN_FILE_COST));
    settle = null;
    await audit("share.upload", { id: share.id, path: share.path, name: saved.name, bytes: saved.bytes, address, from: saved.from || undefined });
    // The stored name isn't returned: it would tell a stranger which names are already taken.
    return NextResponse.json({ ok: true, bytes: saved.bytes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  } finally {
    await settle?.().catch(() => undefined);
    await (folder as AnchoredDirectory | null)?.handle.close().catch(() => undefined);
    releaseSlot?.();
  }
}

async function receiveFile(request: Request, share: UploadShare, declared: number, onFolder: (folder: AnchoredDirectory) => void) {
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({ headers: Object.fromEntries(request.headers.entries()), defParamCharset: "utf8", limits: { files: 1, fields: 1, parts: 2, fieldSize: 256, fileSize: Math.min(config.maxUploadBytes, declared) } });
  } catch {
    throw new AppError("Upload must use multipart form data", 400, "INVALID_UPLOAD");
  }
  let from = "";
  let fileCount = 0;
  let task: Promise<Saved> | null = null;
  let idle: NodeJS.Timeout | undefined;
  const fail = (error: Error) => parser.destroy(error);
  const deadline = setTimeout(() => fail(new AppError("The upload took too long", 408, "UPLOAD_TOO_SLOW")), IDLE_MS + (declared / SLOWEST_BYTES_PER_SECOND) * 1000);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail(new AppError("The upload stopped sending data", 408, "UPLOAD_STALLED")), IDLE_MS);
  };

  const parsed = new Promise<void>((resolve, reject) => {
    parser.on("field", (name, value) => {
      if (name === "from") from = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 64);
    });
    parser.on("file", (field, stream, info) => {
      if (field !== "file" || fileCount > 0) {
        stream.resume();
        return;
      }
      fileCount += 1;
      stream.pause();
      let truncated = false;
      stream.on("limit", () => { truncated = true; });
      task = (async () => {
        const name = publicName(info.filename);
        // Only checking that the folder is the one that was shared needs the lock; the file is then
        // created inside that folder's handle, which nothing can redirect.
        const release = await acquireFilesystemLock();
        let into: AnchoredDirectory;
        try {
          const opened = await openUploadFolder(share);
          if (!opened) throw unavailable();
          onFolder(opened);
          into = opened;
        } finally {
          release();
        }
        // The folder's own disk keeps its floor of free space, counting other uploads in progress.
        const disk = await fsp.statfs(into.base);
        if (Number(disk.bavail) * Number(disk.bsize) - bytesInProgress() - accountBytesStillComing() < KEEP_FREE_BYTES) throw new AppError("The server doesn't have room for this file", 507, "DISK_FULL");
        const target: { name: string; handle: FileHandle; created: Stats } = await reservePublicTarget(into, name);
        let bytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            touch();
            bytes += chunk.length;
            if (bytes > config.maxUploadBytes) callback(new AppError("The file is larger than allowed", 413, "UPLOAD_TOO_LARGE"));
            else callback(null, chunk);
          },
        });
        try {
          // When FilesDude can change owners, a stranger's file belongs to the folder's owner, like other new items.
          if (canChangeOwnership()) await target.handle.chown(into.stat.uid, into.stat.gid);
          stream.resume();
          await pipeline(stream, meter, target.handle.createWriteStream());
          if (truncated) throw new AppError("The file is larger than allowed", 413, "UPLOAD_TOO_LARGE");
          if (bytes === 0) throw new AppError("Empty files can't be sent", 400, "EMPTY_FILE");
          return { name: target.name, bytes, created: target.created, into };
        } catch (error) {
          stream.resume();
          await target.handle.close().catch(() => undefined);
          await removeIfSame(into, target.name, target.created);
          throw error;
        }
      })();
      task.catch((error) => fail(error as Error));
    });
    parser.once("finish", resolve);
    parser.once("error", reject);
  });

  const abort = () => fail(new AppError("The upload was cancelled", 400, "UPLOAD_ABORTED"));
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  touch();
  pipeline(Readable.fromWeb(request.body as never), parser).catch(() => undefined);
  try {
    await parsed;
    if (!task) throw new AppError("Choose a file to upload", 400, "NO_FILE");
    const saved = await (task as Promise<Saved>);
    return { name: saved.name, bytes: saved.bytes, from };
  } catch (error) {
    // A request that fails after its file was written doesn't keep the file.
    const saved = task ? await (task as Promise<Saved>).catch(() => null) : null;
    if (saved) await removeIfSame(saved.into, saved.name, saved.created);
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abort);
  }
}
