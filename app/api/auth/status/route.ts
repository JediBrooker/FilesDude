import { NextResponse } from "next/server";
import { config, configurationIssues } from "@/lib/config";
import { getSession } from "@/lib/auth";
import { getPreferences } from "@/lib/preferences";
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
    ...(session ? {
      features: { trash: config.trashEnabled, videoThumbnails: await videoThumbnailsAvailable(), uploadInPieces: await getPreferences().then((preferences) => preferences.uploadInPieces, () => true) },
      // The build this server runs, so pages loaded before an update can offer to reload.
      build: { version: process.env.NEXT_PUBLIC_FILESDUDE_VERSION || "dev", commit: process.env.NEXT_PUBLIC_FILESDUDE_COMMIT || "" },
    } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}
