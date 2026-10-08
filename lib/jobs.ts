import crypto from "node:crypto";
import { AppError } from "./http";
import type { ArchiveResult, JobProgress, JobState } from "./types";

// Long archive work runs in the background so it outlives a single HTTP request (and any proxy
// timeout); the browser polls for progress. Jobs live in memory and do not survive a restart.
type Job = JobState & { controller: AbortController };
type JobRunner = (report: (progress: JobProgress) => void, signal: AbortSignal) => Promise<ArchiveResult>;

const jobs = new Map<string, Job>();
const KEEP_FINISHED_MS = 15 * 60_000;

function snapshot(job: Job): JobState {
  const { id, kind, label, status, startedAt, finishedAt, result, error } = job;
  return { id, kind, label, status, startedAt, finishedAt, progress: { ...job.progress }, result, error };
}

function prune() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(id);
  }
}

/** Starts a job, allowing one at a time so large archives never compete for the same disk. */
export function startJob(kind: JobState["kind"], label: string, initial: JobProgress, run: JobRunner, onFinish?: (job: JobState) => void) {
  prune();
  if ([...jobs.values()].some((job) => job.status === "running")) {
    throw new AppError("Another archive job is still running. Wait for it to finish or cancel it first.", 409, "JOB_RUNNING");
  }
  const job: Job = { id: crypto.randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString(), progress: initial, controller: new AbortController() };
  jobs.set(job.id, job);
  void run((progress) => { job.progress = progress; }, job.controller.signal)
    .then((result) => {
      job.status = "done";
      job.result = result;
    })
    .catch((error: unknown) => {
      if (job.controller.signal.aborted) {
        job.status = "cancelled";
        return;
      }
      job.status = "failed";
      if (error instanceof AppError) job.error = error.message;
      else {
        console.error(error);
        job.error = "The job failed unexpectedly";
      }
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      onFinish?.(snapshot(job));
    });
  return snapshot(job);
}

export function getJob(id: string) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function listJobs() {
  prune();
  return [...jobs.values()].map(snapshot);
}

export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (!job) throw new AppError("That job no longer exists", 404, "NOT_FOUND");
  if (job.status === "running") job.controller.abort();
  return snapshot(job);
}
