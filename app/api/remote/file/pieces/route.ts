import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getConnection } from "@/lib/connections";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { appendRemoteChunk, cancelRemoteUpload, finishRemoteUpload, remoteUploadStatus, startRemoteUpload } from "@/lib/remote-pieces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Uploading a large file to another server in pieces (see lib/remote-pieces.ts):
//   POST ?id=<server>&path=<folder> {action: "start", name, size}  -> {id, chunkBytes}
//   PUT ?id=<upload>&offset= with the next piece                    -> {received, size}
//   GET ?id=<upload>                                                -> {received, size}
//   POST {action: "finish" | "cancel", id}
const noStore = { headers: { "Cache-Control": "no-store" } };

async function withReceived(error: unknown) {
  const response = jsonError(error);
  const received = (error as { received?: unknown }).received;
  if (typeof received !== "number") return response;
  return NextResponse.json({ ...(await response.json()), received }, { status: response.status });
}

export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async (session) => NextResponse.json(remoteUploadStatus(session, new URL(request.url).searchParams.get("id")), noStore));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const url = new URL(request.url);
      const length = request.headers.get("content-length");
      return NextResponse.json(await appendRemoteChunk(session, url.searchParams.get("id"), url.searchParams.get("offset"), length === null ? null : Number(length), request.body, request.signal), noStore);
    });
  } catch (error) {
    return withReceived(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 8 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as { action?: unknown; id?: unknown; name?: unknown; size?: unknown };
      if (body.action === "start") {
        const params = new URL(request.url).searchParams;
        const connection = params.get("id");
        if (!connection || connection.length > 64) throw new AppError("Choose a server", 400, "INVALID_CONNECTION");
        await getConnection(connection);
        return NextResponse.json(await startRemoteUpload(session, connection, params.get("path") || "", body.name, body.size), noStore);
      }
      if (body.action === "finish") {
        const done = await finishRemoteUpload(session, body.id);
        await audit("remote.upload", { username: session.username, server: (await getConnection(done.connection)).name, folder: done.folder, files: [done.name], bytes: done.bytes, pieces: true });
        return NextResponse.json({ ok: true, uploaded: [done.name] }, noStore);
      }
      if (body.action === "cancel") {
        await cancelRemoteUpload(session, body.id);
        return NextResponse.json({ ok: true }, noStore);
      }
      throw new AppError("Unknown upload operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return withReceived(error);
  }
}
