import crypto from "node:crypto";
import { AppError } from "./http";
import { currentScope } from "./scope";
import type { ArchiveResult, JobProgress, JobState } from "./types";

// Long archive work runs in the background so it outlives a single HTTP request (and any proxy
// timeout); the browser polls for progress. Jobs live in memory and do not survive a restart.
type Job = JobState & { controller: AbortController; accountKey: string };

// Each account sees and cancels only its own jobs; the owner sees all of them.
function visible(job: Job) {
  const scope = currentScope();
  return !scope || scope.role === "owner" || scope.accountKey === job.accountKey;
}
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

/**
 * Starts a job, allowing one at a time per account so large archives don't compete for the disk,
 * and so one account's job never blocks another's.
 */
export function startJob(kind: JobState["kind"], label: string, initial: JobProgress, run: JobRunner, onFinish?: (job: JobState) => void) {
  prune();
  const accountKey = currentScope()?.accountKey ?? "owner";
  if ([...jobs.values()].some((job) => job.status === "running" && job.accountKey === accountKey)) {
    throw new AppError("Another archive job is still running. Wait for it to finish or cancel it first.", 409, "JOB_RUNNING");
  }
  const job: Job = { id: crypto.randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString(), progress: initial, controller: new AbortController(), accountKey };
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
  return job && visible(job) ? snapshot(job) : null;
}

export function listJobs() {
  prune();
  return [...jobs.values()].filter(visible).map(snapshot);
}

/** Stops an account's running jobs, used when the account is changed or deleted. */
export function cancelAccountJobs(accountKey: string) {
  for (const job of jobs.values()) {
    if (job.accountKey === accountKey && job.status === "running") job.controller.abort();
  }
}

export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (!job || !visible(job)) throw new AppError("That job no longer exists", 404, "NOT_FOUND");
  if (job.status === "running") job.controller.abort();
  return snapshot(job);
}
