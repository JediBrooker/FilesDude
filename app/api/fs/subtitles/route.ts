import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertSameOriginFetch, jsonError } from "@/lib/http";
import { listSubtitles, subtitleTrack } from "@/lib/subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A video's subtitle tracks, or one of them (?track=) as WebVTT for the preview. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async () => {
      const params = new URL(request.url).searchParams;
      const relativePath = params.get("path") || "";
      const track = params.get("track");
      if (!track) return NextResponse.json({ tracks: await listSubtitles(relativePath) }, { headers: { "Cache-Control": "no-store" } });
      return new Response(await subtitleTrack(relativePath, track), {
        headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}
