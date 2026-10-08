import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { createShare, listShares, revokeShare } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    return NextResponse.json({ enabled: config.sharingEnabled, shares: config.sharingEnabled ? await listShares() : [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

type ShareBody = { action?: unknown; path?: unknown; hours?: unknown; maxDownloads?: unknown; id?: unknown };

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const parsed = await readJsonBody<unknown>(request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as ShareBody;
    if (body.action === "create") {
      if (typeof body.path !== "string" || body.path.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
      const share = await createShare(body.path, Number(body.hours), body.maxDownloads === null || body.maxDownloads === undefined ? null : Number(body.maxDownloads));
      await audit("share.create", { username: session.username, id: share.id, path: share.path, expiresAt: share.expiresAt, maxDownloads: share.maxDownloads });
      return NextResponse.json({ ok: true, share }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "revoke") {
      if (typeof body.id !== "string" || body.id.length > 64) throw new AppError("Link id is invalid", 400, "INVALID_REQUEST");
      await revokeShare(body.id);
      await audit("share.revoke", { username: session.username, id: body.id });
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    throw new AppError("Unknown share operation", 400, "UNKNOWN_ACTION");
  } catch (error) {
    return jsonError(error);
  }
}
