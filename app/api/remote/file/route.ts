import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getConnection } from "@/lib/connections";
import { config } from "@/lib/config";
import { getMime } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { readRemote, remoteName, remotePath, sftpCall, withSftp, writeRemote } from "@/lib/sftp";
import type { Stats } from "ssh2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dispositionName(name: string) {
  const wellFormed = name.toWellFormed();
  const ascii = wellFormed.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(wellFormed).replace(/['()*!]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const connectionId = (value: string | null) => {
  if (!value || value.length > 64) throw new AppError("Choose a server", 400, "INVALID_CONNECTION");
  return value;
};

/**
 * A file on another server: previewed inline (with byte ranges, so video can seek) under the same
 * locked-down headers as local previews, or downloaded with ?download=1.
 */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async (session) => {
      const params = new URL(request.url).searchParams;
      const id = connectionId(params.get("id"));
      const relative = params.get("path") || "";
      const download = params.get("download") === "1";
      const size = await withSftp(id, async (sftp, root) => {
        const stats = await sftpCall<Stats>((done) => sftp.stat(remotePath(root, relative), done));
        if (!stats.isFile()) throw new AppError("Only files can be opened", 400, "NOT_A_FILE");
        return Number(stats.size);
      });
      const header = request.headers.get("range");
      let range: { start: number; end: number } | undefined;
      if (header && !download) {
        const match = /^bytes=(\d{0,20})-(\d{0,20})$/.exec(header);
        if (!match || (!match[1] && !match[2])) throw new AppError("Invalid byte range", 416);
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size) throw new AppError("Requested range is outside the file", 416);
        range = { start, end };
      }
      const { stream, name } = await readRemote(id, relative, size ? range ?? { start: 0, end: size - 1 } : undefined);
      if (download) await audit("remote.download", { username: session.username, server: (await getConnection(id)).name, path: relative });
      const headers = new Headers({
        "Content-Type": download ? "application/octet-stream" : getMime(name),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Content-Length": String(range ? range.end - range.start + 1 : size),
      });
      if (download) headers.set("Content-Disposition", dispositionName(name));
      if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      request.signal.addEventListener("abort", () => stream.destroy(), { once: true });
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Uploads files from the browser straight into a folder on another server. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const params = new URL(request.url).searchParams;
      const id = connectionId(params.get("id"));
      const folder = params.get("path") || "";
      if (Number(request.headers.get("content-length") || 0) > config.maxUploadBytes + 1024 * 1024) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
      if (!request.body) throw new AppError("Upload body is missing");
      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({ headers: Object.fromEntries(request.headers.entries()), limits: { files: 1, fileSize: config.maxUploadBytes, fields: 2, parts: 3 } });
      } catch {
        throw new AppError("Upload must use multipart form data", 400, "INVALID_UPLOAD");
      }
      const uploaded = await withSftp(id, async (sftp, root) => {
        const target = remotePath(root, folder);
        const names: string[] = [];
        const tasks: Promise<void>[] = [];
        const parsed = new Promise<void>((resolve, reject) => {
          parser.on("file", (field, stream, info) => {
            if (field !== "files") {
              stream.resume();
              return;
            }
            let truncated = false;
            stream.on("limit", () => { truncated = true; });
            const task = (async () => {
              const name = remoteName(info.filename.split(/[\\/]/).pop() ?? "");
              const guard = new Transform({ transform(chunk, _encoding, done) { done(truncated ? new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE") : null, chunk); } });
              names.push(await writeRemote(sftp, target, name, async (destination) => {
                await pipeline(stream, guard, destination);
                if (truncated) throw new AppError("Upload is larger than the configured limit", 413, "UPLOAD_TOO_LARGE");
              }));
            })();
            task.catch((error) => parser.destroy(error as Error));
            tasks.push(task);
          });
          parser.once("finish", resolve);
          parser.once("error", reject);
        });
        request.signal.addEventListener("abort", () => parser.destroy(new AppError("The upload was cancelled", 400, "UPLOAD_ABORTED")), { once: true });
        pipeline(Readable.fromWeb(request.body as never), parser).catch(() => undefined);
        await parsed;
        await Promise.all(tasks);
        if (!names.length) throw new AppError("Choose a file to upload");
        return names;
      });
      await audit("remote.upload", { username: session.username, server: (await getConnection(id)).name, folder, files: uploaded });
      return NextResponse.json({ ok: true, uploaded });
    });
  } catch (error) {
    return jsonError(error);
  }
}
