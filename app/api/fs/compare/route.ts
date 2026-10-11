import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { type CompareSide, type SyncItem, compareFolders, startSyncJob } from "@/lib/folder-compare";
import { AppError, assertMutationRequest, assertSameOriginFetch, jsonError, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A comparison walks two whole folder trees, so each account runs one at a time, and the server a few.
const comparing = new Set<string>();
const MAX_COMPARING = 3;
const MAX_SYNC_ITEMS = 1_000;

/** Compares two folders: ?left=&right=, and contents=1 to compare files byte by byte. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      if (comparing.has(session.accountKey) || comparing.size >= MAX_COMPARING) throw new AppError("Another comparison is still running; try again shortly", 503, "COMPARE_BUSY");
      comparing.add(session.accountKey);
      try {
        const params = new URL(request.url).searchParams;
        const left = params.get("left") ?? "";
        const right = params.get("right") ?? "";
        if (left.length > 4096 || right.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
        const result = await compareFolders(left, right, { contents: params.get("contents") === "1", signal: request.signal });
        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
      } finally {
        comparing.delete(session.accountKey);
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

const TYPES = new Set(["file", "directory", "symlink"]);
const IDENTITY = /^\d{1,24}:\d{1,24}$/;

// One side of an item as the comparison saw it, or null where there was nothing.
function parseSide(value: unknown): CompareSide | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { type, size, mtimeMs, id } = value as Record<string, unknown>;
  if (typeof type !== "string" || !TYPES.has(type) || typeof size !== "number" || !Number.isFinite(size) || typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || typeof id !== "string" || !IDENTITY.test(id)) return undefined;
  return { type: type as CompareSide["type"], size, mtimeMs, modified: "", id };
}

function parseItems(value: unknown): SyncItem[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SYNC_ITEMS) throw new AppError(`Choose between 1 and ${MAX_SYNC_ITEMS.toLocaleString()} items`, 400, "INVALID_ITEMS");
  const seen = new Set<string>();
  return value.map((raw) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const left = parseSide(item.left);
    const right = parseSide(item.right);
    if (typeof item.path !== "string" || !item.path || item.path.length > 4096 || (item.to !== "left" && item.to !== "right") || left === undefined || right === undefined) {
      throw new AppError("An item to sync is invalid", 400, "INVALID_ITEMS");
    }
    // Each item once: the same one twice would be copied (and its copy replaced) twice.
    if (seen.has(item.path)) throw new AppError("An item is listed twice", 400, "INVALID_ITEMS");
    seen.add(item.path);
    return { path: item.path, to: item.to, left, right };
  });
}

/** Copies chosen differences from one folder to the other, as a background job. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
      const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1024 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body) || body.action !== "sync") throw new AppError("Unknown compare operation", 400, "UNKNOWN_ACTION");
      if (typeof body.left !== "string" || typeof body.right !== "string" || body.left.length > 4096 || body.right.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
      const bases = body.bases as Record<string, unknown> | undefined;
      if (!bases || typeof bases.left !== "string" || typeof bases.right !== "string" || !IDENTITY.test(bases.left) || !IDENTITY.test(bases.right)) throw new AppError("Compare the folders again first", 400, "INVALID_REQUEST");
      const job = await startSyncJob(session.username, body.left, body.right, parseItems(body.items), { left: bases.left, right: bases.right });
      return NextResponse.json({ ok: true, job }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
