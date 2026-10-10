import type { Stats } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { withAccess } from "@/lib/access";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { acquireFilesystemLock, removeIfSame, resolveOwnershipPair, uploadOwnershipOptions, withFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { getPreferences } from "@/lib/preferences";
import { NextResponse } from "next/server";
import type { UploadOwnershipOptions } from "@/lib/types";
import { openUploadDestination, type UploadDestination } from "@/lib/upload-destination";
import { applyOwnership, reserveTarget, uploadName } from "@/lib/upload-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    let opened: UploadDestination | null = null;
    try {
      const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > config.maxUploadBytes + 1024 * 1024) {
      throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
    }
    if (!request.body) throw new AppError("Upload body is missing");

    const url = new URL(request.url);
    opened = await openUploadDestination(url, session);
    const { into, directory, ownership: requestedOwnership, batch } = opened;
    if (url.searchParams.get("createFolder") === "1") {
      if (!opened.subfolders.length) throw new AppError("Choose a folder", 400, "INVALID_FOLDER");
      return NextResponse.json({ ok: true, folder: directory });
    }
    // Only opening the destination and creating each file need the lock: files are created inside
    // the open folder's handle, so the bytes can stream in without holding everyone else up.
    releaseFilesystem();

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
          const releaseName = await acquireFilesystemLock();
          const reserved = await reserveTarget(into, directory, name).finally(releaseName);
          const { name: createdName, relative, handle, created } = reserved;
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
            await applyOwnership(handle, requestedOwnership);
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
    // the rest of the body, holding the folder open. pipeline() destroys
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
      await opened?.close();
      releaseFilesystem();
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
