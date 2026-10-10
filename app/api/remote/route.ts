import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getConnection } from "@/lib/connections";
import { assertMutationRequest, assertSameOriginFetch, AppError, jsonError, readJsonBody } from "@/lib/http";
import { startCopyFromServer, startCopyToServer } from "@/lib/remote-transfer";
import { deleteRemote, listRemote, makeRemoteFolder, renameRemote } from "@/lib/sftp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const connectionId = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 64) throw new AppError("Choose a server", 400, "INVALID_CONNECTION");
  return value;
};

/** A folder's contents on one of the owner's other servers. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "owner", async () => {
      const params = new URL(request.url).searchParams;
      return NextResponse.json(await listRemote(connectionId(params.get("id")), params.get("path") || ""), { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

type Body = { action?: unknown; id?: unknown; path?: unknown; paths?: unknown; name?: unknown; destination?: unknown };

const text = (value: unknown, fallback = "") => (typeof value === "string" && value.length <= 4096 ? value : fallback);

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const body = await readJsonBody<Body>(request, 1024 * 1024);
      const id = connectionId(body.id);
      const server = (await getConnection(id)).name;
      const record = (event: string, details: Record<string, unknown>) => audit(event, { username: session.username, server, ...details });
      switch (body.action) {
        case "mkdir": {
          const created = await makeRemoteFolder(id, text(body.path), body.name);
          await record("remote.mkdir", { path: created });
          return NextResponse.json({ path: created });
        }
        case "rename": {
          const renamed = await renameRemote(id, text(body.path), body.name);
          await record("remote.rename", { path: text(body.path), to: renamed });
          return NextResponse.json({ path: renamed });
        }
        case "delete": {
          const paths = Array.isArray(body.paths) ? body.paths.filter((item): item is string => typeof item === "string" && item.length <= 4096) : [];
          if (!paths.length || paths.length > 1_000) throw new AppError("Choose between 1 and 1,000 items", 400, "INVALID_PATHS");
          const removed = await deleteRemote(id, paths, request.signal);
          await record("remote.delete", { paths, removed });
          return NextResponse.json({ removed });
        }
        // Copies run as jobs, shown with progress alongside other copies.
        case "copyFrom": {
          const destination = text(body.destination);
          const job = await startCopyFromServer(id, body.paths, destination, (finished, name) => void audit("remote.copy_from", { username: session.username, server: name, paths: body.paths, destination, status: finished.status, transferred: finished.transferred?.length ?? 0, error: finished.error }));
          return NextResponse.json({ job });
        }
        case "copyTo": {
          const destination = text(body.destination);
          const job = await startCopyToServer(id, body.paths, destination, (finished, name) => void audit("remote.copy_to", { username: session.username, server: name, paths: body.paths, destination, status: finished.status, transferred: finished.transferred?.length ?? 0, error: finished.error }));
          return NextResponse.json({ job });
        }
        default:
          throw new AppError("Unknown action", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
