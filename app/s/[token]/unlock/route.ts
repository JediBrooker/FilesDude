import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientAddress, reachedOverHttps } from "@/lib/auth";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { resolveShareToken, unlockShare } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Entering a link's password: sets the cookie that opens it in this browser for 12 hours. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    assertMutationRequest(request);
    const token = (await params).token;
    const share = await resolveShareToken(token);
    if (!share) throw new AppError("This link is invalid, has expired, or the item is no longer available.", 404, "NOT_FOUND");
    const body = await readJsonBody<{ password?: unknown }>(request, 4 * 1024);
    const address = clientAddress(request);
    let cookie: string;
    try {
      cookie = await unlockShare(share, body && typeof body === "object" ? body.password : undefined, address, token, reachedOverHttps(request));
    } catch (error) {
      if (error instanceof AppError && error.code === "WRONG_PASSWORD") await audit("share.unlock_failed", { id: share.id, path: share.path, address });
      if (error instanceof AppError && error.code === "LINK_LOCKED" && (error as { firstLock?: boolean }).firstLock) await audit("share.unlock_locked", { id: share.id, path: share.path, address });
      throw error;
    }
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.headers.set("Set-Cookie", cookie);
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
