import { audit } from "./audit";
import { purgeExpiredTrash } from "./files";
import { getPreferences } from "./preferences";
import { runUnscoped } from "./scope";

// Trashed items older than the owner's retention setting are deleted forever, checked shortly after
// the service starts handling requests and then every hour. Runs never overlap.
const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_MS = 10_000;
let started = false;
let running: Promise<number> | null = null;

/** Purges expired trash now, as the service rather than any account. Returns how many items went. */
export function runTrashRetention(): Promise<number> {
  running ??= runUnscoped(async () => {
    try {
      const days = (await getPreferences()).trashRetentionDays;
      if (!days) return 0;
      const removed = await purgeExpiredTrash(days);
      if (removed) await audit("trash.purge", { removed, retentionDays: days });
      return removed;
    } finally {
      running = null;
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
