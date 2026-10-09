import crypto from "node:crypto";
import { AppError } from "./http";
import { currentScope } from "./scope";
import type { ArchiveResult, JobProgress, JobState, TransferResult } from "./types";

// Long archive, copy, and move work runs in the background so it outlives a single HTTP request
// (and any proxy timeout); the browser polls for progress. Jobs live in memory and do not survive
// a restart. `done` settles once the job has finished, including its onFinish step.
type Job = JobState & { controller: AbortController; accountKey: string; done: Promise<void>; failure?: unknown };

// Each account sees and cancels only its own jobs; the owner sees all of them.
function visible(job: Job) {
  const scope = currentScope();
  return !scope || scope.role === "owner" || scope.accountKey === job.accountKey;
}
type JobRunner = (report: (progress: JobProgress) => void, signal: AbortSignal) => Promise<ArchiveResult | TransferResult[]>;

// Each account runs one archive job at a time, so large archives don't compete for the disk, and a
// few copies or moves, so a long copy doesn't block a quick move.
const FAMILY_LIMITS = { archive: 1, transfer: 4 };
const familyOf = (kind: JobState["kind"]) => (kind === "copy" || kind === "move" ? "transfer" : "archive");

const jobs = new Map<string, Job>();
const KEEP_FINISHED_MS = 15 * 60_000;

function snapshot(job: Job): JobState {
  const { id, kind, label, status, startedAt, finishedAt, result, error } = job;
  const scope = currentScope();
  const own = !scope || scope.accountKey === job.accountKey;
  return { id, kind, label, status, startedAt, finishedAt, progress: { ...job.progress }, result, transferred: job.transferred && [...job.transferred], error, own };
}

function prune() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(id);
  }
}

/** Starts a job, within per-account limits so one account's jobs never block another's. */
export function startJob(kind: JobState["kind"], label: string, initial: JobProgress, run: JobRunner, onFinish?: (job: JobState) => void | Promise<void>) {
  prune();
  const accountKey = currentScope()?.accountKey ?? "owner";
  const family = familyOf(kind);
  const running = [...jobs.values()].filter((job) => job.status === "running" && job.accountKey === accountKey && familyOf(job.kind) === family);
  if (running.length >= FAMILY_LIMITS[family]) {
    throw new AppError(family === "archive"
      ? "Another archive job is still running. Wait for it to finish or cancel it first."
      : "Several copies or moves are still running. Wait for one to finish or cancel it first.", 409, "JOB_RUNNING");
  }
  let settle!: () => void;
  const done = new Promise<void>((resolve) => { settle = resolve; });
  const job: Job = { id: crypto.randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString(), progress: initial, controller: new AbortController(), accountKey, done };
  jobs.set(job.id, job);
  void run((progress) => { job.progress = progress; }, job.controller.signal)
    .then((result) => {
      job.status = "done";
      if (Array.isArray(result)) job.transferred = result;
      else job.result = result;
    })
    .catch((error: unknown) => {
      job.failure = error;
      // A transfer that stops part-way reports what it already finished.
      const completed = (error as { completed?: unknown }).completed;
      if (Array.isArray(completed)) job.transferred = completed as TransferResult[];
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
    .finally(async () => {
      job.finishedAt = new Date().toISOString();
      try {
        await onFinish?.(snapshot(job));
      } catch (error) {
        console.error(error);
      }
      settle();
    });
  return snapshot(job);
}

/**
 * Waits for a job to finish, or for `timeoutMs` if given, and returns its state. `failure` is the
 * original error of a failed job, so callers can report it with its own status and code.
 */
export async function waitForJob(id: string, timeoutMs?: number) {
  const job = jobs.get(id);
  if (!job || !visible(job)) throw new AppError("That job no longer exists", 404, "NOT_FOUND");
  if (timeoutMs === undefined) await job.done;
  else {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }
  return { state: snapshot(job), failure: job.status === "failed" ? job.failure : undefined };
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
