import type { Stats } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { withAccess } from "@/lib/access";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { acquireFilesystemLock, ensureFolders, isAvailableUploadOwnership, MAX_UPLOAD_FOLDER_DEPTH, openDirectory, removeIfSame, resolveOwnershipPair, uploadOwnershipOptions, withFilesystemLock, type AnchoredDirectory } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { getPreferences } from "@/lib/preferences";
import { NextResponse } from "next/server";
import type { UploadOwnershipOptions } from "@/lib/types";
import { reserveTarget, uploadName } from "@/lib/upload-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The folder inside the destination a file goes into, when uploading a folder: "Photos/2024".
function folderNames(raw: string | null) {
  if (raw === null) return [];
  const names = raw.split("/");
  if (raw.length > 4096 || names.length > MAX_UPLOAD_FOLDER_DEPTH || names.some((name) => !name)) throw new AppError("The upload folder is invalid", 400, "INVALID_FOLDER");
  return names;
}

export async function GET(request: Request) {
  try {
    // Ownership options list the server's users and groups, so they are for the owner only.
    return await withAccess(request, "owner", async () => {
    const directory = new URL(request.url).searchParams.get("path") || "";
    const result = await withFilesystemLock(async () => {
      const [options, preferences] = await Promise.all([uploadOwnershipOptions(directory), getPreferences()]);
      const preference = preferences.uploadOwnership;
      const defaultPair = preference.mode === "fixed"
        ? await resolveOwnershipPair(preference.uid, preference.gid, "default")
        : undefined;
      return { ...options, preference, defaultPair } satisfies UploadOwnershipOptions;
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
    const releaseFilesystem = await acquireFilesystemLock();
    let folder: AnchoredDirectory | null = null;
    let target: AnchoredDirectory | null = null;
    try {
      const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > config.maxUploadBytes + 1024 * 1024) {
      throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
    }
    if (!request.body) throw new AppError("Upload body is missing");

    const url = new URL(request.url);
    const baseDirectory = url.searchParams.get("path") || "";
    const subfolders = folderNames(url.searchParams.get("folder"));
    // The upload this request is part of (each file is its own request), so Activity can show the
    // whole upload as one entry. Every file is still recorded on its own.
    const batchValue = url.searchParams.get("batch");
    const batch = batchValue && /^[A-Za-z0-9-]{8,64}$/.test(batchValue) ? batchValue : undefined;
    folder = await openDirectory(baseDirectory).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "NOT_A_DIRECTORY") throw new AppError("Upload destination is not a folder", 400);
      throw error;
    });
    const destination = folder;

    const uidValue = url.searchParams.get("uid");
    const gidValue = url.searchParams.get("gid");
    if ((uidValue === null) !== (gidValue === null)) throw new AppError("Choose both an owner and group", 400, "INVALID_UPLOAD_OWNERSHIP");
    let requestedOwnership: { uid: number; gid: number } | null = null;
    if (session.role !== "owner") {
      // Only the owner chooses ownership; other accounts' uploads take the destination folder's
      // owner, so files a root service writes stay usable by that folder's users.
      if (uidValue !== null || gidValue !== null) throw new AppError("Only the owner account can choose upload ownership", 403, "FORBIDDEN");
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        requestedOwnership = { uid: destination.stat.uid, gid: destination.stat.gid };
      }
    } else if (uidValue !== null && gidValue !== null) {
      const uid = Number(uidValue);
      const gid = Number(gidValue);
      const preference = (await getPreferences()).uploadOwnership;
      const savedDefault = preference.mode === "fixed" ? { uid: preference.uid, gid: preference.gid } : undefined;
      if (!(await isAvailableUploadOwnership(baseDirectory, uid, gid, savedDefault))) {
        throw new AppError("That owner and group are not available for this folder", 400, "INVALID_UPLOAD_OWNERSHIP");
      }
      requestedOwnership = { uid, gid };
    }

    // Uploading a folder: its top folder is made first (always new, so nothing is merged into an
    // existing folder by accident), and each file then goes into its place inside it, with any
    // folders on the way created as needed.
    let directory = baseDirectory;
    if (subfolders.length) {
      // Other accounts' new folders take the owner of the folder each is made in, as their other new
      // items do; the owner's choice (if any) applies throughout.
      const inherit = session.role !== "owner";
      const ensured = await ensureFolders(destination, baseDirectory, subfolders, { owner: inherit ? null : requestedOwnership, inheritOwner: inherit && requestedOwnership !== null, uniqueFirst: url.searchParams.get("unique") === "1" });
      target = ensured.folder;
      directory = ensured.relative;
      if (inherit && requestedOwnership) requestedOwnership = { uid: target.stat.uid, gid: target.stat.gid };
      // Every folder made is recorded now, under its actual name, even if the upload then fails.
      for (const made of ensured.made) {
        await audit("fs.create", { username: session.username, path: made.split("/").slice(0, -1).join("/"), name: made.split("/").at(-1), upload: true, batch });
      }
      if (url.searchParams.get("createFolder") === "1") return NextResponse.json({ ok: true, folder: directory });
    } else if (url.searchParams.get("createFolder") === "1") {
      throw new AppError("Choose a folder", 400, "INVALID_FOLDER");
    }
    const into = target ?? destination;

    const uploaded: string[] = [];
    const createdTargets: Array<{ name: string; created: Stats }> = [];
    const tasks: Promise<void>[] = [];
    let totalBytes = 0;
    let fileCount = 0;
    let parser: ReturnType<typeof Busboy>;

    try {
      parser = Busboy({
        headers: Object.fromEntries(request.headers.entries()),
        // Browsers send file names as UTF-8; busboy otherwise reads them as Latin-1 and garbles them.
        defParamCharset: "utf8",
        limits: { files: 100, fileSize: config.maxUploadBytes, fields: 5, parts: 105 },
      });
    } catch {
      throw new AppError("Upload must use multipart form data", 400, "INVALID_UPLOAD");
    }

    const parsed = new Promise<void>((resolve, reject) => {
      parser.on("file", (field, stream, info) => {
        if (field !== "files") {
          stream.resume();
          return;
        }
        fileCount += 1;
        stream.pause();
        let truncated = false;
        stream.on("limit", () => { truncated = true; });

        const task = (async () => {
          const name = uploadName(info.filename);
          const { name: createdName, relative, handle, created } = await reserveTarget(into, directory, name);
          createdTargets.push({ name: createdName, created });
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              if (totalBytes > config.maxUploadBytes) callback(new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE"));
              else callback(null, chunk);
            },
          });
          try {
            // Ownership is applied before writing because the write stream closes the handle when
            // it finishes. A stream created with autoClose: false keeps a reference that makes
            // FileHandle.close() wait forever, which hung every upload on current Node releases.
            if (requestedOwnership) {
              try {
                await handle.chown(requestedOwnership.uid, requestedOwnership.gid);
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                  throw new AppError("FilesDude cannot apply that ownership. Run the service as root or choose service ownership.", 403, "CHOWN_DENIED");
                }
                throw error;
              }
            }
            stream.resume();
            await pipeline(stream, meter, handle.createWriteStream());
            if (truncated) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
            uploaded.push(relative);
          } catch (error) {
            stream.resume();
            await handle.close().catch(() => undefined);
            await removeIfSame(into, createdName, created);
            throw error;
          }
        })();
        task.catch((error) => parser.destroy(error as Error));
        tasks.push(task);
      });
      parser.once("finish", resolve);
      parser.once("error", reject);
      parser.once("filesLimit", () => reject(new AppError("Too many uploaded files", 413, "UPLOAD_LIMIT")));
    });

    // A cancelled or dropped upload must tear the parser down: otherwise it waits forever for
    // the rest of the body while this request holds the filesystem lock. pipeline() destroys
    // the parser when the body errors, and the abort signal covers bodies that simply stall.
    // Destroying the parser also fails the in-progress file stream, so its partial file is removed.
    const abortUpload = () => parser.destroy(new AppError("The upload was cancelled", 400, "UPLOAD_ABORTED"));
    request.signal.addEventListener("abort", abortUpload, { once: true });
    // The client may have given up while this request waited for the lock.
    if (request.signal.aborted) abortUpload();
    pipeline(Readable.fromWeb(request.body as never), parser).catch(() => undefined);
    try {
      await parsed;
      await Promise.all(tasks);
    } catch (error) {
      await Promise.allSettled(tasks);
      await Promise.allSettled(createdTargets.map((created) => removeIfSame(into, created.name, created.created)));
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abortUpload);
    }
    if (!fileCount) throw new AppError("Choose at least one file to upload");

    await audit("fs.upload", { username: session.username, directory, files: uploaded, bytes: totalBytes, ownership: requestedOwnership || "service", batch });
    return NextResponse.json({ ok: true, uploaded, ownership: requestedOwnership || null });
    } finally {
      await target?.handle.close().catch(() => undefined);
      await folder?.handle.close().catch(() => undefined);
      releaseFilesystem();
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
