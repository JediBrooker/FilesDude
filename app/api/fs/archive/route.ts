import path from "node:path";
import { NextResponse } from "next/server";
import { archiveSelection, compressEntries, extractArchive } from "@/lib/archives";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { cancelJob, getJob, listJobs, startJob } from "@/lib/jobs";
import type { ArchiveFormat, JobState } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async () => {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return NextResponse.json({ jobs: listJobs() }, { headers: { "Cache-Control": "no-store" } });
      const job = getJob(id);
      if (!job) throw new AppError("That job no longer exists", 404, "NOT_FOUND");
      return NextResponse.json({ job }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

type ArchiveBody = { action?: string; paths?: unknown; destination?: unknown; name?: unknown; format?: unknown; path?: unknown; id?: unknown; select?: unknown };

function stringField(value: unknown, label: string, maxLength = 4096) {
  if (typeof value !== "string" || value.length > maxLength) throw new AppError(`${label} is invalid`, 400, "INVALID_REQUEST");
  return value;
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
    const parsed = await readJsonBody<unknown>(request, 1024 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as ArchiveBody;
    const recordResult = (event: string, details: Record<string, unknown>) => (job: JobState) => {
      void audit(event, { username: session.username, ...details, status: job.status, result: job.result?.path, error: job.error });
    };

    let job: JobState;
    switch (body.action) {
      case "compress": {
        const paths = Array.isArray(body.paths) ? body.paths : [];
        if (!paths.length || paths.length > 1_000 || paths.some((item) => typeof item !== "string" || item.length > 4096)) {
          throw new AppError("Choose between 1 and 1,000 items to compress", 400, "INVALID_PATHS");
        }
        const destination = stringField(body.destination ?? "", "Destination");
        const name = stringField(body.name, "Archive name", 255);
        const format = body.format === "tar.gz" ? "tar.gz" : body.format === "zip" ? "zip" : null;
        if (!format) throw new AppError("Choose zip or tar.gz", 400, "INVALID_FORMAT");
        const label = `Compressing ${paths.length === 1 ? path.posix.basename(paths[0] as string) : `${paths.length} items`}`;
        job = startJob("compress", label, { done: 0, unit: "bytes" },
          (report, signal) => compressEntries(paths as string[], destination, name, format as ArchiveFormat, report, signal),
          recordResult("fs.compress", { paths, destination, format }));
        break;
      }
      case "extract": {
        const archivePath = stringField(body.path, "Archive path");
        // Only some of its items, chosen while looking inside it.
        const selection = body.select === undefined ? null : archiveSelection(body.select);
        const label = selection ? `Extracting ${selection.items.length === 1 ? path.posix.basename(selection.items[0]) : `${selection.items.length} items`} from ${path.posix.basename(archivePath)}` : `Extracting ${path.posix.basename(archivePath)}`;
        job = startJob("extract", label, { done: 0, unit: "bytes" },
          (report, signal) => extractArchive(archivePath, report, signal, {}, selection),
          recordResult("fs.extract", { path: archivePath, items: selection?.items }));
        break;
      }
      case "cancel":
        job = cancelJob(stringField(body.id, "Job id", 64));
        break;
      default:
        throw new AppError("Unknown archive operation", 400, "UNKNOWN_ACTION");
    }
    return NextResponse.json({ ok: true, job }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
