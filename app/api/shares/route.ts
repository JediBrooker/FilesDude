import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { withAccess } from "@/lib/access";
import { config } from "@/lib/config";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { cancelLinkUploads } from "@/lib/chunked-uploads";
import { createShare, createUploadLink, listShares, revokeShare, updateShare } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // Share links publish files to anyone, so creating and managing them is for the owner only.
    return await withAccess(request, "owner", async () => NextResponse.json({ enabled: config.sharingEnabled, shares: config.sharingEnabled ? await listShares() : [] }, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

type ShareBody = { action?: unknown; kind?: unknown; path?: unknown; hours?: unknown; maxDownloads?: unknown; maxBytes?: unknown; maxFiles?: unknown; password?: unknown; id?: unknown };

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
    const parsed = await readJsonBody<unknown>(request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as ShareBody;
    if (body.action === "create") {
      if (typeof body.path !== "string" || body.path.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
      if (body.kind === "upload") {
        const share = await createUploadLink(body.path, Number(body.hours), Number(body.maxBytes), body.maxFiles === null || body.maxFiles === undefined ? null : Number(body.maxFiles), body.password);
        await audit("share.create", { username: session.username, id: share.id, path: share.path, expiresAt: share.expiresAt, kind: "upload", maxBytes: share.maxBytes, maxFiles: share.maxFiles, protected: share.protected || undefined });
        return NextResponse.json({ ok: true, share }, { headers: { "Cache-Control": "no-store" } });
      }
      const share = await createShare(body.path, Number(body.hours), body.maxDownloads === null || body.maxDownloads === undefined ? null : Number(body.maxDownloads), body.password);
      await audit("share.create", { username: session.username, id: share.id, path: share.path, expiresAt: share.expiresAt, maxDownloads: share.maxDownloads, protected: share.protected || undefined });
      return NextResponse.json({ ok: true, share }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "update") {
      if (typeof body.id !== "string" || body.id.length > 64) throw new AppError("Link id is invalid", 400, "INVALID_REQUEST");
      const { link, changed } = await updateShare(body.id, { hours: body.hours, maxDownloads: body.maxDownloads, maxBytes: body.maxBytes, maxFiles: body.maxFiles, password: body.password });
      await audit("share.update", { username: session.username, id: link.id, path: link.path, changed, expiresAt: link.expiresAt });
      return NextResponse.json({ ok: true, share: link }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "revoke") {
      if (typeof body.id !== "string" || body.id.length > 64) throw new AppError("Link id is invalid", 400, "INVALID_REQUEST");
      await revokeShare(body.id);
      // Uploads in progress through a revoked upload link stop now.
      await cancelLinkUploads(body.id);
      await audit("share.revoke", { username: session.username, id: body.id });
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    throw new AppError("Unknown share operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return jsonError(error);
  }
}
