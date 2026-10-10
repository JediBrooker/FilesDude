import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertMutationRequest, assertSameOriginFetch, AppError, jsonError, readJsonBody } from "@/lib/http";
import { openPlayback, playbackStatus, preparePlayback } from "@/lib/playback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A video's copy that plays in any browser (see lib/playback.ts):
//   GET ?path=&status=1       -> whether one exists or is being made, and the video's codecs
//   GET ?path=                -> the copy, as MP4 with byte ranges (so it can seek)
//   POST {action: "prepare", path} -> starts making one
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => {
      assertSameOriginFetch(request);
      const params = new URL(request.url).searchParams;
      const relativePath = params.get("path") || "";
      if (params.get("status") === "1") return NextResponse.json(await playbackStatus(relativePath), { headers: { "Cache-Control": "no-store" } });
      const { handle, size } = await openPlayback(relativePath);
      try {
        const headers = new Headers({
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        let start = 0;
        let end = size - 1;
        let status = 200;
        const range = request.headers.get("range");
        if (range) {
          const match = /^bytes=(\d{0,20})-(\d{0,20})$/.exec(range.trim());
          if (!match || (!match[1] && !match[2])) throw new AppError("Invalid byte range", 416);
          if (match[1]) {
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          } else {
            start = Math.max(0, size - Number(match[2]));
          }
          if (start > end || start >= size) throw new AppError("Requested range is outside the file", 416);
          status = 206;
          headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        headers.set("Content-Length", String(Math.max(0, end - start + 1)));
        return new Response(Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream, { status, headers });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const body = await readJsonBody<{ action?: unknown; path?: unknown }>(request, 8 * 1024);
      if (!body || typeof body !== "object" || body.action !== "prepare" || typeof body.path !== "string" || body.path.length > 4096) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      return NextResponse.json(await preparePlayback(body.path, session.accountKey), { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
