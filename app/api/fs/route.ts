import { NextResponse } from "next/server";
import { assertPermission, withAccess, type Permission } from "@/lib/access";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import {
  applyBulkRename,
  changeMode,
  changeOwner,
  createEntry,
  deleteEntries,
  details,
  listDirectory,
  previewBulkRename,
  renameEntry,
  withFilesystemLock,
  writeTextFile,
} from "@/lib/files";
import { SEARCH_KINDS, searchNames, type SearchKind } from "@/lib/name-search";
import type { BulkRenameRule } from "@/lib/types";
import { config } from "@/lib/config";
import { waitForJob } from "@/lib/jobs";
import { rewriteLinkedPaths, startTransferJob } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Viewing details is reading; changing permissions or ownership is for the owner; the rest edits.
function actionPermission(action: unknown): Permission {
  if (action === "details") return "read";
  if (action === "chmod" || action === "chown") return "owner";
  return "write";
}

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => {
      const url = new URL(request.url);
      const relativePath = url.searchParams.get("path") || "";
      const search = (url.searchParams.get("search") ?? "").trim().slice(0, 256);
      const showHidden = url.searchParams.get("hidden") === "true";
      const kind = (url.searchParams.get("kind") || "any") as SearchKind;
      if (!SEARCH_KINDS.includes(kind)) throw new AppError("Unknown kind of item", 400, "INVALID_FILTER");
      const modifiedWithinDays = Number(url.searchParams.get("modifiedDays") || 0);
      const minBytes = Number(url.searchParams.get("minBytes") || 0);
      if (!Number.isFinite(modifiedWithinDays) || modifiedWithinDays < 0 || !Number.isFinite(minBytes) || minBytes < 0) throw new AppError("Invalid search filter", 400, "INVALID_FILTER");
      // A search walks the tree without holding the filesystem lock (see name-search.ts).
      const result = search || kind !== "any" || modifiedWithinDays || minBytes
        ? await searchNames(relativePath, { query: search, hidden: showHidden, kind, modifiedWithinDays, minBytes }, request.signal)
        : await withFilesystemLock(() => listDirectory(relativePath, showHidden));
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    });
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
    return await withAccess(request, "read", async (session) => {
    const rewriteLinked = (changes: Array<{ from: string; to?: string }>) => rewriteLinkedPaths(changes, session.username);
    const parsed = await readJsonBody<unknown>(request, 16 * 1024 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as ActionBody;
    if (body.path !== undefined && (typeof body.path !== "string" || body.path.length > 4096)) throw new AppError("Path is invalid", 400, "INVALID_PATH");
    if (body.destination !== undefined && (typeof body.destination !== "string" || body.destination.length > 4096)) throw new AppError("Destination is invalid", 400, "INVALID_PATH");
    if (body.name !== undefined && (typeof body.name !== "string" || Buffer.byteLength(body.name, "utf8") > 255)) throw new AppError("Name is invalid", 400, "INVALID_NAME");
    for (const flag of ["permanent", "requireTrash", "apply"] as const) {
      if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    }
    const paths = Array.isArray(body.paths) ? body.paths : [];
    if (paths.length > 1_000 || paths.some((item) => typeof item !== "string" || item.length > 4096)) {
      throw new AppError("Too many or invalid paths", 400, "INVALID_PATHS");
    }
    assertPermission(session, actionPermission(body.action));
    // Copies and moves run as jobs (shown with progress by /api/fs/jobs). Here the request waits for
    // the job, which takes the filesystem lock only for its quick steps.
    if (body.action === "copy" || body.action === "move") {
      if (body.destination === undefined) throw new AppError("Destination is required");
      const finished = await waitForJob(startTransferJob(session.username, body.action, paths, body.destination, true).id);
      if (finished.failure) throw finished.failure;
      if (finished.state.status !== "done") throw new AppError("The transfer was cancelled", 409, "JOB_CANCELLED");
      return NextResponse.json({ ok: true, result: finished.state.transferred ?? [] }, { headers: { "Cache-Control": "no-store" } });
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

    // Only what each action uses is recorded: its items, a new or changed name, permissions, owner,
    // whether a delete was permanent, and whether a bulk rename was applied rather than previewed.
    const action = body.action;
    await audit(`fs.${action}`, {
      username: session.username,
      path: action === "delete" || action === "chmod" || action === "chown" || action === "bulkRename" ? undefined : body.path,
      paths: action === "delete" || action === "chmod" || action === "chown" || action === "bulkRename" ? paths : undefined,
      permanent: action === "delete" ? Boolean(body.permanent) : undefined,
      name: action === "create" || action === "rename" ? body.name : undefined,
      mode: action === "chmod" ? String(body.mode) : undefined,
      uid: action === "chown" ? Number(body.uid) : undefined,
      gid: action === "chown" ? Number(body.gid) : undefined,
      apply: action === "bulkRename" ? Boolean(body.apply) : undefined,
    });
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
