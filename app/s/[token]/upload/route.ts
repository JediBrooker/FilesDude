import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/auth";
import { config } from "@/lib/config";
import { acquireFilesystemLock, diskInfo, removeIfSame, type AnchoredDirectory } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { isUploadShare, openUploadFolder, reserveUpload, resolveShareToken, type UploadShare } from "@/lib/shares";
import { reserveTarget, uploadName } from "@/lib/upload-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public and unauthenticated: one file per request, into the link's folder, within the link's limits.
// Uploads never replace anything and the response never says what's in the folder.
const MAX_PUBLIC_UPLOADS = 8;
const MAX_UPLOADS_PER_ADDRESS = 3;
// An upload that sends nothing for this long is dropped, so it can't hold a slot forever.
const IDLE_MS = 60_000;
// Uploads through links always leave this much space free on the disk.
const KEEP_FREE_BYTES = 2 * 1024 ** 3;
// Room for the multipart wrapping around the file in the request body.
const MULTIPART_ALLOWANCE = 64 * 1024;

type Saved = { name: string; bytes: number; created: Stats; into: AnchoredDirectory };

let activeUploads = 0;
const uploadsByAddress = new Map<string, number>();

const unavailable = () => new AppError("This link is invalid, has expired, or the folder is no longer available.", 404, "NOT_FOUND");

// Names come from strangers and are shown in the owner's file list: invisible and direction-changing
// characters are replaced so a name reads as what it is.
function publicName(raw: string) {
  return uploadName(raw.replace(/[\p{Cc}\p{Cf}]/gu, "_"));
}

function takeSlot(address: string) {
  const mine = uploadsByAddress.get(address) ?? 0;
  if (activeUploads >= MAX_PUBLIC_UPLOADS) throw new AppError("The server is busy with other uploads. Try again in a minute.", 503, "BUSY");
  if (mine >= MAX_UPLOADS_PER_ADDRESS) throw new AppError(`Upload at most ${MAX_UPLOADS_PER_ADDRESS} files at a time`, 429, "TOO_MANY_UPLOADS");
  activeUploads += 1;
  uploadsByAddress.set(address, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
    const left = (uploadsByAddress.get(address) ?? 1) - 1;
    if (left <= 0) uploadsByAddress.delete(address);
    else uploadsByAddress.set(address, left);
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  let releaseSlot: (() => void) | null = null;
  let settle: ((saved?: number) => Promise<void>) | null = null;
  let folder: AnchoredDirectory | null = null;
  try {
    assertMutationRequest(request);
    const share = await resolveShareToken((await params).token);
    if (!share || !isUploadShare(share)) throw unavailable();
    const address = clientAddress(request);

    const declared = Number(request.headers.get("content-length"));
    if (!request.headers.get("content-length") || !Number.isInteger(declared) || declared <= 0) throw new AppError("The upload's size is missing", 411, "LENGTH_REQUIRED");
    if (declared > config.maxUploadBytes + MULTIPART_ALLOWANCE) throw new AppError(`Files can be at most ${Math.floor(config.maxUploadBytes / 1024 ** 2)} MB each`, 413, "UPLOAD_TOO_LARGE");
    if (!request.body) throw new AppError("Upload body is missing", 400);
    releaseSlot = takeSlot(address);
    // The whole request is counted against the link while it uploads; only the file's bytes are kept.
    settle = await reserveUpload(share.id, declared);
    const disk = await diskInfo();
    if (disk.available - declared < KEEP_FREE_BYTES) throw new AppError("The server doesn't have room for this file", 507, "DISK_FULL");

    const saved = await receiveFile(request, share, declared, (opened) => { folder = opened; });
    await settle(saved.bytes);
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
        // The folder is opened and the file created under the lock; the bytes are written after it.
        const release = await acquireFilesystemLock();
        let target: { name: string; handle: FileHandle; created: Stats };
        let into: AnchoredDirectory;
        try {
          const opened = await openUploadFolder(share);
          if (!opened) throw unavailable();
          onFolder(opened);
          into = opened;
          target = await reserveTarget(opened, share.path, name);
        } finally {
          release();
        }
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
          // When running as root, a stranger's file belongs to the folder's owner, like other new items.
          if (typeof process.getuid === "function" && process.getuid() === 0) await target.handle.chown(into.stat.uid, into.stat.gid);
          stream.resume();
          await pipeline(stream, meter, target.handle.createWriteStream());
          if (truncated) throw new AppError("The file is larger than allowed", 413, "UPLOAD_TOO_LARGE");
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
    request.signal.removeEventListener("abort", abort);
  }
}
