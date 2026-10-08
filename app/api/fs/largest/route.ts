import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { largestFiles, withFilesystemLock } from "@/lib/files";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // The whole-tree scan spans every account's folders, so it is for the owner only.
    return await withAccess(request, "owner", async () => {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 100);
    const requestedOffset = Number(url.searchParams.get("offset") || 0);
    const requestedMinBytes = Number(url.searchParams.get("minBytes") || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(10, Math.floor(requestedLimit))) : 100;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const minBytes = Number.isFinite(requestedMinBytes) ? Math.max(0, Math.floor(requestedMinBytes)) : 0;
    const result = await withFilesystemLock(() => largestFiles({ refresh: url.searchParams.get("refresh") === "true", minBytes, offset, limit }));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
