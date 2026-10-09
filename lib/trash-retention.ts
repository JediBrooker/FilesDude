import { audit } from "./audit";
import { purgeExpiredTrash, type TrashPurgeResult } from "./files";
import { getPreferences } from "./preferences";
import { runUnscoped } from "./scope";

// Trashed items older than the owner's retention setting are deleted forever, checked shortly after
// the service starts handling requests and then every hour. Runs never overlap.
const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_MS = 10_000;
let started = false;
let running: Promise<number> | null = null;

const currentRetention = async () => (await getPreferences()).trashRetentionDays;

/**
 * Purges expired trash now, as the service rather than any account. Returns how many items went.
 * Whatever was removed is audited, even if the run stopped part-way.
 */
export function runTrashRetention(): Promise<number> {
  running ??= runUnscoped(async () => {
    let outcome: TrashPurgeResult = { removed: [], failed: 0 };
    try {
      if (!(await currentRetention())) return 0;
      outcome = await purgeExpiredTrash(currentRetention);
      return outcome.removed.length;
    } finally {
      running = null;
      if (outcome.removed.length || outcome.failed) {
        await audit("trash.purge", { removed: outcome.removed.length, items: outcome.removed, failed: outcome.failed, retentionDays: await currentRetention().catch(() => null) });
      }
    }
  });
  return running;
}

function scheduledRun() {
  void runTrashRetention().catch((error: unknown) => console.error("Could not purge expired trash", error));
}

/** Starts the hourly check once; called on every authenticated request. */
export function startTrashRetention() {
  if (started) return;
  started = true;
  setTimeout(scheduledRun, FIRST_CHECK_MS).unref();
  setInterval(scheduledRun, CHECK_EVERY_MS).unref();
}
