import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { requireSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { isAvailableUploadOwnership, resolveOwnershipPair, safeResolve, uploadOwnershipOptions } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { getPreferences } from "@/lib/preferences";
import { NextResponse } from "next/server";
import type { UploadOwnershipOptions } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function uploadName(raw: string) {
  const name = path.basename(raw).trim();
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    throw new AppError("An uploaded file has an invalid name", 400, "INVALID_NAME");
  }
  return name;
}

async function reserveTarget(directory: string, name: string) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName = index === 0 ? name : `${stem} (${index})${extension}`;
    const relative = [directory, candidateName].filter(Boolean).join("/");
    const target = await safeResolve(relative, { mustExist: false });
    try {
      const handle = await fsp.open(target, "wx", 0o640);
      return { target, relative, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new AppError("Unable to choose an available upload name", 409);
}

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const directory = new URL(request.url).searchParams.get("path") || "";
    const [options, preferences] = await Promise.all([uploadOwnershipOptions(directory), getPreferences()]);
    const preference = preferences.uploadOwnership;
    const defaultPair = preference.mode === "fixed"
      ? await resolveOwnershipPair(preference.uid, preference.gid, "default")
      : undefined;
    const result: UploadOwnershipOptions = { ...options, preference, defaultPair };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > config.maxUploadBytes + 1024 * 1024) {
      throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
    }
    if (!request.body) throw new AppError("Upload body is missing");

    const url = new URL(request.url);
    const directory = url.searchParams.get("path") || "";
    const destination = await safeResolve(directory);
    if (!(await fsp.stat(destination)).isDirectory()) throw new AppError("Upload destination is not a folder", 400);

    const uidValue = url.searchParams.get("uid");
    const gidValue = url.searchParams.get("gid");
    if ((uidValue === null) !== (gidValue === null)) throw new AppError("Choose both an owner and group", 400, "INVALID_UPLOAD_OWNERSHIP");
    let requestedOwnership: { uid: number; gid: number } | null = null;
    if (uidValue !== null && gidValue !== null) {
      const uid = Number(uidValue);
      const gid = Number(gidValue);
      const preference = (await getPreferences()).uploadOwnership;
      const savedDefault = preference.mode === "fixed" ? { uid: preference.uid, gid: preference.gid } : undefined;
      if (!(await isAvailableUploadOwnership(directory, uid, gid, savedDefault))) {
        throw new AppError("That owner and group are not available for this folder", 400, "INVALID_UPLOAD_OWNERSHIP");
      }
      requestedOwnership = { uid, gid };
    }

    const uploaded: string[] = [];
    const createdTargets: string[] = [];
    const tasks: Promise<void>[] = [];
    let totalBytes = 0;
    let fileCount = 0;
    let parser: ReturnType<typeof Busboy>;

    try {
      parser = Busboy({
        headers: Object.fromEntries(request.headers.entries()),
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
          const { target, relative, handle } = await reserveTarget(directory, name);
          createdTargets.push(target);
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              if (totalBytes > config.maxUploadBytes) callback(new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE"));
              else callback(null, chunk);
            },
          });
          stream.resume();
          try {
            await pipeline(stream, meter, handle.createWriteStream());
            if (truncated) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
            if (requestedOwnership) {
              try {
                await fsp.chown(target, requestedOwnership.uid, requestedOwnership.gid);
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                  throw new AppError("FilesDude cannot apply that ownership. Run the service as root or choose service ownership.", 403, "CHOWN_DENIED");
                }
                throw error;
              }
            }
            uploaded.push(relative);
          } catch (error) {
            await handle.close().catch(() => undefined);
            await fsp.rm(target, { force: true }).catch(() => undefined);
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

    Readable.fromWeb(request.body as never).pipe(parser);
    try {
      await parsed;
      await Promise.all(tasks);
    } catch (error) {
      await Promise.allSettled(tasks);
      await Promise.allSettled(createdTargets.map((target) => fsp.rm(target, { force: true })));
      throw error;
    }
    if (!fileCount) throw new AppError("Choose at least one file to upload");

    await audit("fs.upload", { username: session.username, directory, files: uploaded, bytes: totalBytes, ownership: requestedOwnership || "service" });
    return NextResponse.json({ ok: true, uploaded, ownership: requestedOwnership || null });
  } catch (error) {
    return jsonError(error);
  }
}
