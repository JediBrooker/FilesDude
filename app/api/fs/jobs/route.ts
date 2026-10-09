import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { cancelJob, getJob, listJobs, waitForJob } from "@/lib/jobs";
import { startTransferJob } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A copy or move that finishes within this long (most moves are a single rename) is answered as
// finished, so the browser doesn't wait a polling interval to show the result.
const QUICK_FINISH_MS = 600;

/** Lists the jobs the account can see, or reports one job's progress with ?id=. */
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

type JobsBody = { action?: unknown; id?: unknown; paths?: unknown; destination?: unknown };

/** Starts a copy or move job, or cancels a job. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "write", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 1024 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as JobsBody;
      if (body.action === "cancel") {
        if (typeof body.id !== "string" || body.id.length > 64) throw new AppError("Job id is invalid", 400, "INVALID_REQUEST");
        return NextResponse.json({ ok: true, job: cancelJob(body.id) }, { headers: { "Cache-Control": "no-store" } });
      }
      if (body.action !== "copy" && body.action !== "move") throw new AppError("Unknown job operation", 400, "UNKNOWN_ACTION");
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length || paths.length > 1_000 || paths.some((item) => typeof item !== "string" || item.length > 4096)) {
        throw new AppError("Choose between 1 and 1,000 items", 400, "INVALID_PATHS");
      }
      if (typeof body.destination !== "string" || body.destination.length > 4096) throw new AppError("Destination is invalid", 400, "INVALID_PATH");
      const started = startTransferJob(session.username, body.action, paths as string[], body.destination);
      const { state } = await waitForJob(started.id, QUICK_FINISH_MS);
      return NextResponse.json({ ok: true, job: state }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
