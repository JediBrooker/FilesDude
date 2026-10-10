import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { appendChunk, cancelChunkedUpload, chunkedUploadStatus, finishChunkedUpload, startChunkedUpload } from "@/lib/chunked-uploads";
import { acquireFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { openUploadDestination } from "@/lib/upload-destination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Uploading a large file in pieces (see lib/chunked-uploads.ts):
//   POST {action: "start", name, size} with the same query as /api/fs/upload  -> {id, chunkBytes}
//   PUT ?id=&offset= with the next piece as the body                         -> {received, size}
//   GET ?id=                                   (where to carry on from)       -> {received, size}
//   POST {action: "finish" | "cancel", id}
const noStore = { headers: { "Cache-Control": "no-store" } };

function withReceived(error: unknown) {
  const response = jsonError(error);
  const received = (error as { received?: unknown }).received;
  if (typeof received !== "number") return response;
  return response.json().then((body) => NextResponse.json({ ...body, received }, { status: response.status }));
}

export async function GET(request: Request) {
  try {
    return await withAccess(request, "write", async (session) => NextResponse.json(chunkedUploadStatus(session, new URL(request.url).searchParams.get("id")), noStore));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
      const url = new URL(request.url);
      const length = request.headers.get("content-length");
      const result = await appendChunk(session, url.searchParams.get("id"), url.searchParams.get("offset"), length === null ? null : Number(length), request.body, request.signal);
      return NextResponse.json(result, noStore);
    });
  } catch (error) {
    return withReceived(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 8 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as { action?: unknown; id?: unknown; name?: unknown; size?: unknown };
      if (body.action === "start") {
        const release = await acquireFilesystemLock();
        try {
          // The account may have been changed while this waited for the lock.
          const current = await getSession(request);
          if (!current || current.accountKey !== session.accountKey || current.credentialsVersion !== session.credentialsVersion) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
          const destination = await openUploadDestination(new URL(request.url), session);
          try {
            return NextResponse.json(await startChunkedUpload(session, destination, body.name, body.size), noStore);
          } catch (error) {
            await destination.close();
            throw error;
          }
        } finally {
          release();
        }
      }
      if (body.action === "finish") {
        const done = await finishChunkedUpload(session, body.id);
        await audit("fs.upload", { username: session.username, directory: done.directory, files: [done.relative], bytes: done.bytes, ownership: done.ownership || "service", batch: done.batch, pieces: true });
        return NextResponse.json({ ok: true, uploaded: [done.relative], ownership: done.ownership }, noStore);
      }
      if (body.action === "cancel") {
        await cancelChunkedUpload(session, body.id);
        return NextResponse.json({ ok: true }, noStore);
      }
      throw new AppError("Unknown upload operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return withReceived(error);
  }
}
