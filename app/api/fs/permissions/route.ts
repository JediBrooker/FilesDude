import path from "node:path";
import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { changeAccess, type AccessChange } from "@/lib/files";
import { AppError, assertMutationRequest, jsonError, readJsonBody } from "@/lib/http";
import { startJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A preview only counts, so it stops sooner than the change itself.
const PREVIEW_LIMITS = { entries: 200_000, milliseconds: 30_000 };

function mode(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) throw new AppError("Permissions must be an octal value such as 755", 400, "INVALID_MODE");
  return Number.parseInt(value, 8) & 0o1777;
}

function id(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4_294_967_294) throw new AppError("Owner and group must be numeric ids", 400, "INVALID_OWNER");
  return value;
}

/**
 * Previews or applies permissions and ownership (owner only): `fileMode` and `folderMode` (octal),
 * `uid` and `gid`, each optional, to the items in `paths` and, with `recursive`, everything inside.
 */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const body = await readJsonBody<Record<string, unknown>>(request, 1024 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body) || (body.action !== "preview" && body.action !== "apply")) throw new AppError("Unknown permissions operation", 400, "UNKNOWN_ACTION");
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length || paths.length > 1_000 || paths.some((item) => typeof item !== "string" || !item || item.length > 4096)) throw new AppError("Choose between 1 and 1,000 items", 400, "INVALID_PATHS");
      if (body.recursive !== undefined && typeof body.recursive !== "boolean") throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const change: AccessChange = { fileMode: mode(body.fileMode), folderMode: mode(body.folderMode), uid: id(body.uid), gid: id(body.gid), recursive: Boolean(body.recursive) };
      if (change.fileMode === null && change.folderMode === null && change.uid === null && change.gid === null) throw new AppError("Choose permissions or an owner to set", 400, "NOTHING_TO_CHANGE");
      if (body.action === "preview") {
        const report = await changeAccess(paths as string[], change, { apply: false, signal: request.signal, limits: PREVIEW_LIMITS });
        return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
      }
      const subject = paths.length === 1 ? path.posix.basename(paths[0] as string) : `${paths.length} items`;
      const job = startJob("access", `${change.uid !== null || change.gid !== null ? "Changing ownership of" : "Changing permissions of"} ${subject}`, { done: 0, unit: "entries" },
        async (report, signal) => ({ access: await changeAccess(paths as string[], change, { apply: true, signal, report }) }),
        async (finished) => {
          const modeText = (value: number | null) => (value === null ? undefined : value.toString(8).padStart(3, "0"));
          await audit("fs.access", { username: session.username, paths, fileMode: modeText(change.fileMode), folderMode: modeText(change.folderMode), uid: change.uid ?? undefined, gid: change.gid ?? undefined, recursive: change.recursive, changed: finished.access?.changed, skipped: finished.access?.skipped || undefined, status: finished.status, error: finished.error });
        });
      return NextResponse.json({ ok: true, job }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
