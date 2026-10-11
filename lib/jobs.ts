import crypto from "node:crypto";
import { AppError } from "./http";
import { currentScope } from "./scope";
import type { AccessReport, ArchiveResult, JobProgress, JobState, TransferResult } from "./types";

// Long archive, copy, and move work runs in the background so it outlives a single HTTP request
// (and any proxy timeout); the browser polls for progress. Jobs live in memory and do not survive
// a restart. `done` settles once the job has finished, including its onFinish step. A failure keeps
// only its status and code, so it can be reported as it was raised without holding on to the error.
type JobFamily = keyof typeof FAMILY_LIMITS;
type Job = JobState & { controller: AbortController; accountKey: string; family: JobFamily; done: Promise<void>; errorStatus?: number; errorCode?: string };

// Each account sees and cancels only its own jobs; the owner sees all of them.
function visible(job: Job) {
  const scope = currentScope();
  return !scope || scope.role === "owner" || scope.accountKey === job.accountKey;
}
// A transfer's results may carry the items it left alone (`skipped`), as a sync's do.
type Transferred = TransferResult[] & { skipped?: JobState["skipped"] };
type JobRunner = (report: (progress: JobProgress) => void, signal: AbortSignal) => Promise<ArchiveResult | Transferred | { access: AccessReport }>;

// Each account runs one archive job at a time, so large archives don't compete for the disk, and a
// few copies or moves, so a long copy doesn't block a quick move. Copies and moves that a request
// waits for (such as undo) have their own allowance, so background transfers can't block them.
const FAMILY_LIMITS = { archive: 1, transfer: 4, request: 4 };

const jobs = new Map<string, Job>();
const KEEP_FINISHED_MS = 15 * 60_000;
const KEEP_FINISHED_PER_ACCOUNT = 10;

function snapshot(job: Job): JobState {
  const { id, kind, label, status, startedAt, finishedAt, result, error } = job;
  const scope = currentScope();
  const own = !scope || scope.accountKey === job.accountKey;
  return { id, kind, label, status, startedAt, finishedAt, progress: { ...job.progress }, result, transferred: job.transferred && [...job.transferred], skipped: job.skipped && [...job.skipped], access: job.access && { ...job.access }, error, own };
}

// Finished jobs are kept for a while so the browser can collect their outcome, but each account
// keeps only the ones that finished most recently.
function prune() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  const kept = new Map<string, number>();
  const finished = [...jobs].filter(([, job]) => job.finishedAt).sort(([, a], [, b]) => b.finishedAt!.localeCompare(a.finishedAt!));
  for (const [id, job] of finished) {
    const count = (kept.get(job.accountKey) ?? 0) + 1;
    kept.set(job.accountKey, count);
    if (Date.parse(job.finishedAt!) < cutoff || count > KEEP_FINISHED_PER_ACCOUNT) jobs.delete(id);
  }
}

/** Starts a job, within per-account limits so one account's jobs never block another's. */
export function startJob(kind: JobState["kind"], label: string, initial: JobProgress, run: JobRunner, onFinish?: (job: JobState) => void | Promise<void>, options: { awaited?: boolean } = {}) {
  prune();
  const accountKey = currentScope()?.accountKey ?? "owner";
  const family: JobFamily = kind === "compress" || kind === "extract" ? "archive" : options.awaited ? "request" : "transfer";
  const running = [...jobs.values()].filter((job) => job.status === "running" && job.accountKey === accountKey && job.family === family);
  if (running.length >= FAMILY_LIMITS[family]) {
    throw new AppError(family === "archive"
      ? "Another archive job is still running. Wait for it to finish or cancel it first."
      : "Several copies or moves are still running. Wait for one to finish or cancel it first.", 409, "JOB_RUNNING");
  }
  let settle!: () => void;
  const done = new Promise<void>((resolve) => { settle = resolve; });
  const job: Job = { id: crypto.randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString(), progress: initial, controller: new AbortController(), accountKey, family, done };
  jobs.set(job.id, job);
  void run((progress) => { job.progress = progress; }, job.controller.signal)
    .then((result) => {
      job.status = "done";
      if (Array.isArray(result)) {
        job.transferred = [...result];
        if (result.skipped) job.skipped = result.skipped;
      } else if ("access" in result) job.access = result.access;
      else job.result = result;
    })
    .catch((error: unknown) => {
      if (error instanceof AppError) Object.assign(job, { errorStatus: error.status, errorCode: error.code });
      // A transfer that stops part-way reports what it already finished.
      const completed = (error as { completed?: unknown }).completed;
      if (Array.isArray(completed)) {
        job.transferred = [...completed] as TransferResult[];
        if ((completed as Transferred).skipped) job.skipped = (completed as Transferred).skipped;
      }
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
 * Waits for a job to finish, or for `timeoutMs` if given, and returns its state. `failure` is an
 * error for a failed job with the original message, status, and code.
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
  const failure = job.status === "failed" ? new AppError(job.error ?? "The job failed unexpectedly", job.errorStatus ?? 500, job.errorCode) : undefined;
  return { state: snapshot(job), failure };
}

export function getJob(id: string) {
  const job = jobs.get(id);
  return job && visible(job) ? snapshot(job) : null;
}

/** Every job the account can see, without transfer results (those come with each job by id). */
export function listJobs() {
  prune();
  return [...jobs.values()].filter(visible).map((job) => ({ ...snapshot(job), transferred: undefined }));
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
