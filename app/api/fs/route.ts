import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import {
  applyBulkRename,
  changeMode,
  changeOwner,
  copyOrMove,
  createEntry,
  deleteEntries,
  details,
  PartialTransferError,
  listDirectory,
  previewBulkRename,
  renameEntry,
  searchFiles,
  withFilesystemLock,
  writeTextFile,
} from "@/lib/files";
import type { BulkRenameRule } from "@/lib/types";
import { rewriteFavoritePaths } from "@/lib/favorites";
import { rewriteSharePaths } from "@/lib/shares";
import { config } from "@/lib/config";

// Favourites and share links follow items that are renamed or moved, and drop deleted ones.
async function rewriteLinkedPaths(changes: Array<{ from: string; to?: string }>, username: string) {
  await rewriteFavoritePaths(changes);
  const revoked = await rewriteSharePaths(changes);
  if (revoked.length) await audit("share.revoke", { username, ids: revoked, reason: "item deleted" });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const url = new URL(request.url);
    const relativePath = url.searchParams.get("path") || "";
    const search = url.searchParams.get("search")?.trim();
    const showHidden = url.searchParams.get("hidden") === "true";
    const result = await withFilesystemLock(() => search
      ? searchFiles(relativePath, search, showHidden)
      : listDirectory(relativePath, showHidden));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

type ActionBody = {
  action?: string;
  path?: string;
  paths?: string[];
  name?: string;
  type?: "file" | "directory";
  destination?: string;
  permanent?: boolean;
  /** Refuse instead of deleting permanently when protected trash is turned off (used by undo). */
  requireTrash?: boolean;
  mode?: string;
  uid?: number;
  gid?: number;
  rule?: BulkRenameRule;
  apply?: boolean;
  content?: string;
};

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const rewriteLinked = (changes: Array<{ from: string; to?: string }>) => rewriteLinkedPaths(changes, session.username);
    const parsed = await readJsonBody<unknown>(request, 16 * 1024 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as ActionBody;
    if (body.path !== undefined && (typeof body.path !== "string" || body.path.length > 4096)) throw new AppError("Path is invalid", 400, "INVALID_PATH");
    if (body.destination !== undefined && (typeof body.destination !== "string" || body.destination.length > 4096)) throw new AppError("Destination is invalid", 400, "INVALID_PATH");
    if (body.name !== undefined && (typeof body.name !== "string" || Buffer.byteLength(body.name, "utf8") > 255)) throw new AppError("Name is invalid", 400, "INVALID_NAME");
    const paths = Array.isArray(body.paths) ? body.paths : [];
    if (paths.length > 1_000 || paths.some((item) => typeof item !== "string" || item.length > 4096)) {
      throw new AppError("Too many or invalid paths", 400, "INVALID_PATHS");
    }
    const result = await withFilesystemLock(async () => {
      let operationResult: unknown = { ok: true };
      switch (body.action) {
      case "create":
        if (!body.name || !body.type) throw new AppError("Name and item type are required");
        operationResult = await createEntry(body.path || "", body.name, body.type);
        break;
      case "rename":
        if (!body.path || !body.name) throw new AppError("Path and new name are required");
        operationResult = await renameEntry(body.path, body.name);
        await rewriteLinked([{ from: body.path, to: (operationResult as { path: string }).path }]);
        break;
      case "delete":
        if (body.requireTrash && (body.permanent || !config.trashEnabled)) {
          throw new AppError("Protected trash is turned off, so nothing was deleted", 409, "TRASH_DISABLED");
        }
        operationResult = await deleteEntries(paths, Boolean(body.permanent));
        await rewriteLinked(paths.map((favoritePath) => ({ from: favoritePath })));
        break;
      case "copy":
      case "move": {
        if (body.destination === undefined) throw new AppError("Destination is required");
        let transferred;
        try {
          transferred = await copyOrMove(paths, body.destination, body.action === "move");
        } catch (error) {
          // Keep favourites pointing at items that moved before the failure.
          if (error instanceof PartialTransferError && body.action === "move") {
            await rewriteLinked(error.completed.map((item) => ({ from: item.source, to: item.path })));
          }
          throw error;
        }
        if (body.action === "move") await rewriteLinked(transferred.map((item) => ({ from: item.source, to: item.path })));
        operationResult = transferred;
        break;
      }
      case "chmod":
        if (!body.mode) throw new AppError("Permissions are required");
        await changeMode(paths, body.mode);
        break;
      case "chown":
        if (body.uid === undefined || body.gid === undefined) throw new AppError("Owner and group ids are required");
        await changeOwner(paths, Number(body.uid), Number(body.gid));
        break;
      case "bulkRename":
        if (!body.rule) throw new AppError("Bulk rename rules are required");
        operationResult = body.apply
          ? await applyBulkRename(paths, body.rule)
          : await previewBulkRename(paths, body.rule);
        if (body.apply) {
          await rewriteLinked((operationResult as Array<{ source: string; to: string; changed: boolean }>).filter((item) => item.changed).map((item) => ({ from: item.source, to: [item.source.split("/").slice(0, -1).join("/"), item.to].filter(Boolean).join("/") })));
        }
        break;
      case "details":
        if (!body.path) throw new AppError("Path is required");
        operationResult = await details(body.path);
        break;
      case "write":
        if (!body.path || typeof body.content !== "string") throw new AppError("Path and text content are required");
        operationResult = await writeTextFile(body.path, body.content);
        break;
      default:
        throw new AppError("Unknown file operation", 400, "UNKNOWN_ACTION");
      }
      return operationResult;
    });

    await audit(`fs.${body.action}`, {
      username: session.username,
      path: body.path,
      paths,
      destination: body.destination,
      permanent: body.permanent,
    });
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
