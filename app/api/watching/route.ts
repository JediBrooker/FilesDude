import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { continueWatching, forgetWatching, saveWatchPosition, watchingIn, watchPosition } from "@/lib/watching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

// Where the signed-in account got to in its videos:
//   GET ?path=      -> that video's position (or null)
//   GET ?folder=    -> watched and part-watched videos in a folder
//   GET             -> videos part-way through, most recent first
//   POST {action: "save", path, position, duration} | {action: "forget", path?}
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      const params = new URL(request.url).searchParams;
      if (params.has("path")) return NextResponse.json({ entry: await watchPosition(session.accountKey, params.get("path")) }, noStore);
      if (params.has("folder")) return NextResponse.json({ entries: await watchingIn(session.accountKey, params.get("folder") ?? "") }, noStore);
      return NextResponse.json({ entries: await continueWatching(session.accountKey) }, noStore);
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const body = await readJsonBody<{ action?: unknown; path?: unknown; position?: unknown; duration?: unknown }>(request, 8 * 1024);
      if (!body || typeof body !== "object") throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      if (body.action === "save") return NextResponse.json({ entry: await saveWatchPosition(session.accountKey, body.path, body.position, body.duration) }, noStore);
      if (body.action === "forget") {
        await forgetWatching(session.accountKey, body.path);
        return NextResponse.json({ ok: true }, noStore);
      }
      throw new AppError("Unknown operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return jsonError(error);
  }
}
