import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";
import { listSubtitles, subtitleTrack } from "@/lib/subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each account has a few subtitle requests going at once, so one can't crowd out the rest.
const MAX_ACTIVE_PER_ACCOUNT = 4;
const active = new Map<string, number>();

/** A video's subtitle tracks, or one of them (?track=) as WebVTT for the preview. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      const account = session.accountKey;
      if ((active.get(account) ?? 0) >= MAX_ACTIVE_PER_ACCOUNT) throw new AppError("Other subtitles are still being prepared; try again shortly", 503, "SUBTITLES_BUSY");
      active.set(account, (active.get(account) ?? 0) + 1);
      try {
        const params = new URL(request.url).searchParams;
        const relativePath = params.get("path") || "";
        const track = params.get("track");
        if (!track) return NextResponse.json({ tracks: await listSubtitles(relativePath) }, { headers: { "Cache-Control": "no-store" } });
        return new Response(await subtitleTrack(relativePath, track, account, request.signal), {
          headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
        });
      } finally {
        const remaining = (active.get(account) ?? 1) - 1;
        if (remaining > 0) active.set(account, remaining);
        else active.delete(account);
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
