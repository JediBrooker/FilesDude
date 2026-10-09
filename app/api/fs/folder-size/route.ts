import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { childFolderSizes, folderSize } from "@/lib/folder-size";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Counting walks a whole folder tree, so each account counts at most two folders at once.
const MAX_ACTIVE_PER_ACCOUNT = 2;
const active = new Map<string, number>();

/** The size and contents of a folder (for Properties) or of each folder in it (for the list). */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      const account = session.accountKey;
      if ((active.get(account) ?? 0) >= MAX_ACTIVE_PER_ACCOUNT) throw new AppError("Other folders are still being counted; try again shortly", 503, "FOLDER_SIZE_BUSY");
      active.set(account, (active.get(account) ?? 0) + 1);
      try {
        const params = new URL(request.url).searchParams;
        const relativePath = params.get("path") || "";
        // With children=1, the size of each folder directly inside, for the Size column.
        const result = params.get("children") === "1" ? await childFolderSizes(relativePath, request.signal) : await folderSize(relativePath, request.signal);
        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
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
