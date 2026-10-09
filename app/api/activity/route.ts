import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { readActivity } from "@/lib/activity";
import { ACTIVITY_CATEGORIES, type ActivityCategory } from "@/lib/activity-text";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A page of the audit log, newest first, for the owner. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "owner", async () => {
      const params = new URL(request.url).searchParams;
      const category = params.get("category") || "all";
      if (!ACTIVITY_CATEGORIES.some((item) => item.id === category)) throw new AppError("Unknown activity category", 400, "INVALID_CATEGORY");
      const user = (params.get("user") || "").slice(0, 128);
      const query = (params.get("q") || "").trim().slice(0, 200);
      const page = await readActivity({ category: category as ActivityCategory | "all", user, query }, params.get("cursor"));
      return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
