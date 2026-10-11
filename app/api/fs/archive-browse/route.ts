import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { listArchive } from "@/lib/archive-browse";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Opening a tar reads it through, so each account reads a couple of archives at once.
const MAX_ACTIVE_PER_ACCOUNT = 2;
const MAX_ACTIVE = 8;
const active = new Map<string, number>();
let activeTotal = 0;

/** What one folder of an archive holds: ?path= (the archive) and folder= (inside it). */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      const account = session.accountKey;
      if ((active.get(account) ?? 0) >= MAX_ACTIVE_PER_ACCOUNT || activeTotal >= MAX_ACTIVE) throw new AppError("Other archives are still being read; try again shortly", 503, "ARCHIVE_BUSY");
      active.set(account, (active.get(account) ?? 0) + 1);
      activeTotal += 1;
      try {
        const params = new URL(request.url).searchParams;
        const archive = params.get("path") ?? "";
        const folder = params.get("folder") ?? "";
        if (archive.length > 4096 || folder.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
        return NextResponse.json(await listArchive(archive, folder), { headers: { "Cache-Control": "no-store" } });
      } finally {
        activeTotal -= 1;
        const left = (active.get(account) ?? 1) - 1;
        if (left > 0) active.set(account, left);
        else active.delete(account);
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
