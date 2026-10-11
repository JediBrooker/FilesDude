import { NextResponse } from "next/server";
import { assertPermission, withAccess, type Permission } from "@/lib/access";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import {
  applyBulkRename,
  changeAccess,
  createEntry,
  createLink,
  deleteEntries,
  details,
  listDirectory,
  listFolders,
  previewBulkRename,
  renameEntry,
  retargetLink,
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

const running = new Map<string, number>();

/** Runs `work` unless this account already has `max` of this kind going (then it's told to wait). */
async function oneOfFew<T>(kind: string, account: string, max: number, work: () => Promise<T>) {
  const key = `${kind}:${account}`;
  const count = running.get(key) ?? 0;
  if (count >= max) throw new AppError(kind === "search" ? "Your other searches are still running; try again in a moment" : "Your other folders are still loading; try again in a moment", 429, "BUSY");
  running.set(key, count + 1);
  try {
    return await work();
  } finally {
    const left = (running.get(key) ?? 1) - 1;
    if (left > 0) running.set(key, left);
    else running.delete(key);
  }
}

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      const url = new URL(request.url);
      const relativePath = url.searchParams.get("path") || "";
      const search = (url.searchParams.get("search") ?? "").trim().slice(0, 256);
      const showHidden = url.searchParams.get("hidden") === "true";
      // Just the folders inside, for the folder tree.
      if (url.searchParams.get("folders") === "1") return NextResponse.json(await listFolders(relativePath, showHidden), { headers: { "Cache-Control": "no-store" } });
      const kind = (url.searchParams.get("kind") || "any") as SearchKind;
      if (!SEARCH_KINDS.includes(kind)) throw new AppError("Unknown kind of item", 400, "INVALID_FILTER");
      const modifiedWithinDays = Number(url.searchParams.get("modifiedDays") || 0);
      const minBytes = Number(url.searchParams.get("minBytes") || 0);
      if (!Number.isFinite(modifiedWithinDays) || modifiedWithinDays < 0 || !Number.isFinite(minBytes) || minBytes < 0) throw new AppError("Invalid search filter", 400, "INVALID_FILTER");
      // A search walks the tree, and a listing reads its folder, without holding the filesystem lock
      // (see name-search.ts and listDirectory); each account has a few of each going at once.
      const searching = Boolean(search || kind !== "any" || modifiedWithinDays || minBytes);
      const result = await oneOfFew(searching ? "search" : "list", session.accountKey, searching ? 2 : 4, () => (searching
        ? searchNames(relativePath, { query: search, hidden: showHidden, kind, modifiedWithinDays, minBytes }, request.signal)
        : listDirectory(relativePath, showHidden)));
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
  /** For making a link: what kind, and (to point a link elsewhere) what at. */
  kind?: "symbolic" | "hard";
  target?: string;
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
    if (body.target !== undefined && (typeof body.target !== "string" || body.target.length > 4096)) throw new AppError("Link target is invalid", 400, "INVALID_PATH");
    if (body.kind !== undefined && body.kind !== "symbolic" && body.kind !== "hard") throw new AppError("Choose a symbolic or hard link", 400, "INVALID_REQUEST");
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
        // Through the same careful walk as the permissions dialog: one item, no links followed.
        if (typeof body.mode !== "string" || !/^[0-7]{3,4}$/.test(body.mode)) throw new AppError("Permissions must be an octal value such as 755", 400, "INVALID_MODE");
        await changeAccess(paths, { fileMode: Number.parseInt(body.mode, 8) & 0o1777, folderMode: Number.parseInt(body.mode, 8) & 0o3777, uid: null, gid: null, recursive: false, keepSpecial: body.mode.length === 3 }, { apply: true });
        break;
      case "chown":
        if (body.uid === undefined || body.gid === undefined) throw new AppError("Owner and group ids are required");
        await changeAccess(paths, { fileMode: null, folderMode: null, uid: Number(body.uid), gid: Number(body.gid), recursive: false }, { apply: true });
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
      case "link":
        if (!body.path || !body.name || !body.kind) throw new AppError("The item, a name, and the kind of link are required");
        operationResult = await createLink(body.path, body.destination ?? "", body.name, body.kind);
        break;
      case "relink":
        if (!body.path || body.target === undefined) throw new AppError("The link and where it should point are required");
        operationResult = await retargetLink(body.path, body.target);
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
      name: action === "create" || action === "rename" || action === "link" ? body.name : undefined,
      destination: action === "link" ? body.destination ?? "" : undefined,
      kind: action === "link" ? body.kind : undefined,
      target: action === "relink" ? body.target : undefined,
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
