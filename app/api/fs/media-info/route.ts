import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertSameOriginFetch, jsonError } from "@/lib/http";
import { mediaInfoFor } from "@/lib/media-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Media details of an image, video, or audio file, for Properties. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      const info = await mediaInfoFor(new URL(request.url).searchParams.get("path") || "", session.accountKey);
      return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
