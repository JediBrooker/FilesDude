import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { clearTags, setTag, tagCounts, taggedWith, tagsIn } from "@/lib/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

// The signed-in account's colour tags:
//   GET ?folder=   -> tags on the items in a folder
//   GET ?color=    -> the items with that colour
//   GET            -> how many items have each colour
//   POST {action: "set", paths, color, on} | {action: "clear", paths}
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => {
      const params = new URL(request.url).searchParams;
      if (params.has("folder")) return NextResponse.json({ tags: await tagsIn(params.get("folder")) }, noStore);
      if (params.has("color")) return NextResponse.json({ entries: await taggedWith(params.get("color")) }, noStore);
      return NextResponse.json({ counts: await tagCounts() }, noStore);
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async () => {
      const body = await readJsonBody<{ action?: unknown; paths?: unknown; color?: unknown; on?: unknown }>(request, 512 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      if (body.action === "set") return NextResponse.json({ tags: await setTag(body.paths, body.color, body.on), counts: await tagCounts() }, noStore);
      if (body.action === "clear") {
        await clearTags(body.paths);
        return NextResponse.json({ ok: true, counts: await tagCounts() }, noStore);
      }
      throw new AppError("Unknown operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return jsonError(error);
  }
}
