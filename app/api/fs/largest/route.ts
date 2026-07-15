import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { largestFiles } from "@/lib/files";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(10, Math.floor(requestedLimit))) : 100;
    const result = await largestFiles(url.searchParams.get("refresh") === "true");
    return NextResponse.json({ ...result, entries: result.entries.slice(0, limit) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
