import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { AppError, assertMutationRequest, jsonError, readJsonBody } from "@/lib/http";
import { deleteSavedSearch, listSavedSearches, saveSearch } from "@/lib/saved-searches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => NextResponse.json({ searches: await listSavedSearches() }, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

/** Saves a search ({ action: "save", search }) or deletes one ({ action: "delete", id }). */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async () => {
      const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      let searches;
      if (body.action === "save") searches = await saveSearch(body.search);
      else if (body.action === "delete" && typeof body.id === "string" && body.id.length <= 64) searches = await deleteSavedSearch(body.id);
      else throw new AppError("Unknown saved search operation", 400, "UNKNOWN_ACTION");
      return NextResponse.json({ ok: true, searches }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
