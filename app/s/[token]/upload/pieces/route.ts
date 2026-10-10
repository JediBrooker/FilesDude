import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/auth";
import { appendChunk, cancelChunkedUpload, chunkedUploadStatus, finishChunkedUpload, startLinkUpload, type UploadOwner } from "@/lib/chunked-uploads";
import { assertMutationRequest, assertSameOriginFetch, AppError, jsonError, readJsonBody } from "@/lib/http";
import { isUnlocked, isUploadShare, resolveShareToken } from "@/lib/shares";
import { addressGroup } from "@/lib/upload-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Large files through an upload link, in pieces (see lib/chunked-uploads.ts). Public: every request
// carries the link, which must still be active, and the upload's own id.
//   POST {action: "start", name, size, from?}   -> {id, chunkBytes}
//   PUT ?id=&offset= with the next piece         -> {received, size}
//   GET ?id=                                     -> {received, size}
//   POST {action: "finish" | "cancel", id}
const noStore = { headers: { "Cache-Control": "no-store" } };
const unavailable = () => new AppError("This link is invalid, has expired, or the folder is no longer available.", 404, "NOT_FOUND");

async function linkFor(request: Request, params: Promise<{ token: string }>) {
  const share = await resolveShareToken((await params).token);
  if (!share || !isUploadShare(share)) throw unavailable();
  if (!isUnlocked(share, request.headers.get("cookie"))) throw new AppError("This link needs its password. Reload the page and enter it.", 401, "PASSWORD_REQUIRED");
  const address = clientAddress(request);
  const owner: UploadOwner = { kind: "link", shareId: share.id, group: addressGroup(address) };
  return { share, address, owner };
}

async function withReceived(error: unknown) {
  const response = jsonError(error);
  const received = (error as { received?: unknown }).received;
  if (typeof received !== "number") return response;
  return NextResponse.json({ ...(await response.json()), received }, { status: response.status });
}

type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    assertSameOriginFetch(request);
    const { owner } = await linkFor(request, params);
    return NextResponse.json(chunkedUploadStatus(owner, new URL(request.url).searchParams.get("id")), noStore);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    assertMutationRequest(request);
    const { owner } = await linkFor(request, params);
    const url = new URL(request.url);
    const length = request.headers.get("content-length");
    return NextResponse.json(await appendChunk(owner, url.searchParams.get("id"), url.searchParams.get("offset"), length === null ? null : Number(length), request.body, request.signal), noStore);
  } catch (error) {
    return withReceived(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    assertMutationRequest(request);
    const { share, address, owner } = await linkFor(request, params);
    const parsed = await readJsonBody<unknown>(request, 8 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as { action?: unknown; id?: unknown; name?: unknown; size?: unknown; from?: unknown };
    if (body.action === "start") return NextResponse.json(await startLinkUpload(share, address, body.name, body.size, body.from), noStore);
    if (body.action === "finish") {
      const done = await finishChunkedUpload(owner, body.id);
      await audit("share.upload", { id: share.id, path: share.path, name: done.name, bytes: done.bytes, address, from: done.from || undefined, pieces: true });
      // The stored name isn't returned: it would tell a stranger which names are already taken.
      return NextResponse.json({ ok: true, bytes: done.bytes }, noStore);
    }
    if (body.action === "cancel") {
      await cancelChunkedUpload(owner, body.id);
      return NextResponse.json({ ok: true }, noStore);
    }
    throw new AppError("Unknown upload operation", 400, "UNKNOWN_ACTION");
  } catch (error) {
    return withReceived(error);
  }
}
