import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/favorites";
import { withFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    return NextResponse.json({ favorites: await listFavorites() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const parsed = await readJsonBody<unknown>(request, 16 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as { action?: unknown; path?: unknown };
    if ((body.action !== "add" && body.action !== "remove") || typeof body.path !== "string" || !body.path || body.path.length > 4096) {
      throw new AppError("A valid folder and favourite action are required", 400, "INVALID_REQUEST");
    }
    const favorites = await withFilesystemLock(() => body.action === "add" ? addFavorite(body.path as string) : removeFavorite(body.path as string));
    await audit(`favorites.${body.action}`, { username: session.username, path: body.path });
    return NextResponse.json({ ok: true, favorites }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
