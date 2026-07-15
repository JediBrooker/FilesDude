import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/favorites";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";

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
    const body = (await request.json()) as { action?: "add" | "remove"; path?: string };
    if (!body.path || !body.action) throw new AppError("A folder and favourite action are required");
    const favorites = body.action === "add" ? await addFavorite(body.path) : await removeFavorite(body.path);
    await audit(`favorites.${body.action}`, { username: session.username, path: body.path });
    return NextResponse.json({ ok: true, favorites }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
