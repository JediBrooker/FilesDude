import { Readable } from "node:stream";
import { withAccess } from "@/lib/access";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "@/lib/files";
import { AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => {
    const relativePath = new URL(request.url).searchParams.get("path") || "";
    const releaseFilesystem = await acquireFilesystemLock();
    try {
      const { absolute, handle, stat } = await openVerifiedFile(relativePath);
      if (!stat.isFile()) {
        await handle.close();
        throw new AppError("Only files can be previewed", 400);
      }

      try {
        const headers = new Headers({
          "Content-Type": getMime(absolute),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        const range = request.headers.get("range");
        let start = 0;
        let end = stat.size - 1;
        let status = 200;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match) throw new AppError("Invalid byte range", 416);
          start = match[1] ? Number(match[1]) : 0;
          end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
          if (start > end || start >= stat.size) throw new AppError("Requested range is outside the file", 416);
          status = 206;
          headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        headers.set("Content-Length", String(Math.max(0, end - start + 1)));
        const stream = handle.createReadStream({ start, end });
        releaseFilesystem();
        return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      releaseFilesystem();
      throw error;
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
