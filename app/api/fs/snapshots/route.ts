import path from "node:path";
import { NextResponse } from "next/server";
import { assertPermission, withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { details, restoreFromSnapshot, withFilesystemLock } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { startJob, waitForJob } from "@/lib/jobs";
import { getPreferences, parseSnapshotSchedule, savePreferences } from "@/lib/preferences";
import { runSnapshotSchedule } from "@/lib/snapshot-schedule";
import { createSnapshot, deleteSnapshot, itemVersions, listSnapshotFolder, listSnapshots, snapshotItem, snapshotSupport } from "@/lib/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Without parameters: whether snapshots are available and the list (with sizes, the dataset, and
 * the schedule for the owner). view=versions&path=: an item's earlier versions. view=browse&snapshot=
 * &path=: a folder inside a snapshot. Every account sees only what is inside its own folder.
 */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      const url = new URL(request.url);
      const view = url.searchParams.get("view");
      const itemPath = url.searchParams.get("path") || "";
      if (view === "versions") {
        const current = await withFilesystemLock(() => details(itemPath)).catch(() => null);
        return NextResponse.json({ versions: await itemVersions(itemPath, current) }, noStore);
      }
      if (view === "browse") {
        return NextResponse.json(await listSnapshotFolder(url.searchParams.get("snapshot") || "", itemPath, url.searchParams.get("hidden") === "true"), noStore);
      }
      const support = await snapshotSupport();
      if (!support.available) return NextResponse.json({ available: false }, noStore);
      const isOwner = session.role === "owner";
      const snapshots = (await listSnapshots()).map((snapshot) => (isOwner ? snapshot : { ...snapshot, used: undefined }));
      return NextResponse.json({
        available: true,
        snapshots,
        ...(isOwner ? { dataset: support.dataset, schedule: (await getPreferences()).snapshotSchedule } : {}),
      }, noStore);
    });
  } catch (error) {
    return jsonError(error);
  }
}

type SnapshotsBody = { action?: unknown; name?: unknown; snapshot?: unknown; path?: unknown; schedule?: unknown };

function restoredLabel(createdAt: string) {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `restored ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** Owner: take, delete, or schedule snapshots. Editors and the owner: restore an item from one. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 16 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as SnapshotsBody;
      switch (body.action) {
        case "restore": {
          if (typeof body.snapshot !== "string" || typeof body.path !== "string" || body.path.length > 4096) throw new AppError("Choose a snapshot and an item", 400, "INVALID_REQUEST");
          const item = await snapshotItem(body.snapshot, body.path);
          if (!item.relative) throw new AppError("Choose an item inside the snapshot to restore", 400, "INVALID_REQUEST");
          if (!item.stat.isFile() && !item.stat.isDirectory() && !item.stat.isSymbolicLink()) throw new AppError("Only files, folders, and links can be restored", 400, "UNSUPPORTED_FILE_TYPE");
          const parent = path.posix.dirname(item.relative) === "." ? "" : path.posix.dirname(item.relative);
          const label = restoredLabel(item.snapshot.createdAt);
          const started = startJob("restore", `Restoring ${item.name}`, { done: 0, unit: "bytes" },
            async (report, signal) => [await restoreFromSnapshot(item.folder, item.name, parent, label, { report, signal })],
            async (job) => {
              await audit("snapshots.restore", { username: session.username, snapshot: item.snapshot.name, path: item.relative, status: job.status, restoredTo: job.transferred?.[0]?.path, error: job.error });
            });
          const { state } = await waitForJob(started.id, 600);
          return NextResponse.json({ ok: true, job: state }, noStore);
        }
        case "create": {
          assertPermission(session, "owner");
          const snapshot = await createSnapshot("manual");
          await audit("snapshots.create", { username: session.username, name: snapshot.name });
          return NextResponse.json({ ok: true, snapshot, snapshots: await listSnapshots(true) }, noStore);
        }
        case "delete": {
          assertPermission(session, "owner");
          if (typeof body.name !== "string" || body.name.length > 255) throw new AppError("Choose a snapshot", 400, "INVALID_REQUEST");
          const snapshot = await deleteSnapshot(body.name);
          await audit("snapshots.delete", { username: session.username, name: snapshot.name });
          return NextResponse.json({ ok: true, snapshots: await listSnapshots(true) }, noStore);
        }
        case "schedule": {
          assertPermission(session, "owner");
          const schedule = parseSnapshotSchedule(body.schedule);
          if (!(await snapshotSupport()).available) throw new AppError("Snapshots need the root folder to be on ZFS", 404, "SNAPSHOTS_UNAVAILABLE");
          await savePreferences({ ...(await getPreferences()), snapshotSchedule: schedule, updatedAt: new Date().toISOString() });
          await audit("snapshots.schedule", { username: session.username, schedule });
          // Applied straight away: a first snapshot if one is due, and pruning to the new limit.
          if (schedule.frequency !== "off") await runSnapshotSchedule().catch((error: unknown) => console.error("Scheduled snapshot failed", error));
          return NextResponse.json({ ok: true, schedule, snapshots: await listSnapshots(true) }, noStore);
        }
        default:
          throw new AppError("Unknown snapshot operation", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
