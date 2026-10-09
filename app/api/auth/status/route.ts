import { NextResponse } from "next/server";
import { configurationIssues } from "@/lib/config";
import { getSession } from "@/lib/auth";
import { videoThumbnailsAvailable } from "@/lib/video-frames";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const issues = configurationIssues();
  const session = await getSession(request);
  return NextResponse.json({
    authenticated: Boolean(session),
    username: session?.username || null,
    role: session?.role ?? null,
    root: session?.root ?? null,
    configured: issues.length === 0,
    configurationIssues: issues,
    // What this server can do, for signed-in pages to offer.
    ...(session ? { features: { videoThumbnails: await videoThumbnailsAvailable() } } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}
