import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { cancelDuplicateScan, duplicateStatus, isDuplicateScanRunning, linkDuplicates, startDuplicateScan, trashDuplicates } from "@/lib/duplicates";
import { withFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { rewriteLinkedPaths } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** The running scan's progress and the last report. Scanning reads the whole tree, so it is for the owner. */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async () => {
      const url = new URL(request.url);
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      return NextResponse.json(duplicateStatus({ offset, limit }), noStore);
    });
  } catch (error) {
    return jsonError(error);
  }
}

type DuplicatesBody = { action?: unknown; path?: unknown; minBytes?: unknown; paths?: unknown };

/** Start or cancel a scan, or move chosen copies to the trash (always keeping one of each). */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 2 * 1024 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as DuplicatesBody;
      if ((body.action === "link" || body.action === "trash") && isDuplicateScanRunning()) {
        throw new AppError("Wait for the scan to finish (or cancel it) before changing files", 409, "JOB_RUNNING");
      }
      switch (body.action) {
        case "scan": {
          const folder = typeof body.path === "string" && body.path.length <= 4096 ? body.path : "";
          const minBytes = typeof body.minBytes === "number" ? body.minBytes : 1024 * 1024;
          await startDuplicateScan(folder, minBytes);
          await audit("duplicates.scan", { username: session.username, path: folder, minBytes });
          return NextResponse.json({ ok: true, ...duplicateStatus() }, noStore);
        }
        case "cancel":
          cancelDuplicateScan();
          return NextResponse.json({ ok: true }, noStore);
        case "link": {
          if (!config.trashEnabled) throw new AppError("Protected trash is turned off, so duplicates can't be replaced safely here", 409, "TRASH_DISABLED");
          const requested = Array.isArray(body.paths) ? body.paths : [];
          if (!requested.length || requested.length > 1000 || requested.some((item) => typeof item !== "string" || item.length > 4096)) {
            throw new AppError("Choose between 1 and 1,000 copies", 400, "INVALID_PATHS");
          }
          // The paths keep working as links, so favourites and share links stay put.
          const result = await withFilesystemLock(() => linkDuplicates(requested as string[]));
          await audit("duplicates.link", { username: session.username, linked: result.linked.map((item) => ({ path: item.path, to: item.target, trashId: item.trashId })), skipped: result.skipped });
          return NextResponse.json({ ok: true, result, ...duplicateStatus() }, noStore);
        }
        case "trash": {
          if (!config.trashEnabled) throw new AppError("Protected trash is turned off, so duplicates can't be removed safely here", 409, "TRASH_DISABLED");
          const requested = Array.isArray(body.paths) ? body.paths : [];
          if (!requested.length || requested.length > 1000 || requested.some((item) => typeof item !== "string" || item.length > 4096)) {
            throw new AppError("Choose between 1 and 1,000 copies", 400, "INVALID_PATHS");
          }
          // Checks, removals, and the report update happen together under the lock.
          const result = await withFilesystemLock(async () => {
            const outcome = await trashDuplicates(requested as string[]);
            await rewriteLinkedPaths(outcome.trashed.map((item) => ({ from: item.path })), session.username);
            return outcome;
          });
          await audit("duplicates.trash", { username: session.username, paths: result.trashed.map((item) => item.path), changed: result.changed });
          return NextResponse.json({ ok: true, result, ...duplicateStatus() }, noStore);
        }
        default:
          throw new AppError("Unknown duplicates operation", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
