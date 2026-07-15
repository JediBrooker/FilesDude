import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import {
  applyBulkRename,
  changeMode,
  changeOwner,
  copyOrMove,
  createEntry,
  deleteEntries,
  details,
  listDirectory,
  previewBulkRename,
  renameEntry,
  searchFiles,
  writeTextFile,
} from "@/lib/files";
import type { BulkRenameRule } from "@/lib/types";
import { rewriteFavoritePaths } from "@/lib/favorites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const url = new URL(request.url);
    const relativePath = url.searchParams.get("path") || "";
    const search = url.searchParams.get("search")?.trim();
    const showHidden = url.searchParams.get("hidden") === "true";
    const result = search
      ? await searchFiles(relativePath, search, showHidden)
      : await listDirectory(relativePath, showHidden);
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
    const body = (await request.json()) as ActionBody;
    const paths = Array.isArray(body.paths) ? body.paths : [];
    let result: unknown = { ok: true };

    switch (body.action) {
      case "create":
        if (!body.name || !body.type) throw new AppError("Name and item type are required");
        result = await createEntry(body.path || "", body.name, body.type);
        break;
      case "rename":
        if (!body.path || !body.name) throw new AppError("Path and new name are required");
        result = await renameEntry(body.path, body.name);
        await rewriteFavoritePaths([{ from: body.path, to: (result as { path: string }).path }]);
        break;
      case "delete":
        await deleteEntries(paths, Boolean(body.permanent));
        await rewriteFavoritePaths(paths.map((favoritePath) => ({ from: favoritePath })));
        break;
      case "copy":
      case "move":
        if (body.destination === undefined) throw new AppError("Destination is required");
        await copyOrMove(paths, body.destination, body.action === "move");
        if (body.action === "move") {
          const destination = body.destination.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
          await rewriteFavoritePaths(paths.map((source) => ({ from: source, to: [destination, source.split("/").at(-1)].filter(Boolean).join("/") })));
        }
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
        result = body.apply
          ? await applyBulkRename(paths, body.rule)
          : await previewBulkRename(paths, body.rule);
        if (body.apply) {
          await rewriteFavoritePaths((result as Array<{ source: string; to: string; changed: boolean }>).filter((item) => item.changed).map((item) => ({ from: item.source, to: [item.source.split("/").slice(0, -1).join("/"), item.to].filter(Boolean).join("/") })));
        }
        break;
      case "details":
        if (!body.path) throw new AppError("Path is required");
        result = await details(body.path);
        break;
      case "write":
        if (!body.path || typeof body.content !== "string") throw new AppError("Path and text content are required");
        result = await writeTextFile(body.path, body.content);
        break;
      default:
        throw new AppError("Unknown file operation", 400, "UNKNOWN_ACTION");
    }

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
