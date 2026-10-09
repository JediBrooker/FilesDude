import { NextResponse } from "next/server";
import { assertPermission, withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { deleteTrashItems, emptyTrash, listTrash, restoreTrashItems, withFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { getPreferences } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "write", async () => {
      const [result, preferences] = await Promise.all([withFilesystemLock(() => listTrash()), getPreferences()]);
      return NextResponse.json({ ...result, retentionDays: preferences.trashRetentionDays }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

type TrashBody = { action?: string; ids?: unknown };

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
    const parsed = await readJsonBody<unknown>(request, 1024 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as TrashBody;
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length > 1_000 || ids.some((id) => typeof id !== "string" || id.length > 512)) {
      throw new AppError("Too many or invalid trash items", 400, "INVALID_TRASH_ITEMS");
    }
    const result = await withFilesystemLock(async () => {
      switch (body.action) {
      case "restore":
        return restoreTrashItems(ids as string[]);
      case "delete":
        return deleteTrashItems(ids as string[]);
      case "empty":
        // Emptying removes every account's deleted items, so only the owner may do it.
        assertPermission(session, "owner");
        return emptyTrash();
      default:
        throw new AppError("Unknown trash operation", 400, "UNKNOWN_ACTION");
      }
    });

    await audit(`trash.${body.action}`, {
      username: session.username,
      ids: body.action === "empty" ? undefined : ids,
      restored: body.action === "restore" ? result : undefined,
      removed: body.action === "empty" ? (result as { removed: number }).removed : undefined,
    });
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
