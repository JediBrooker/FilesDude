import { audit } from "./audit";
import { getPreferences } from "./preferences";
import { createSnapshot, deleteSnapshot, listSnapshots, snapshotSupport, type Snapshot } from "./snapshots";

// Takes FilesDude's automatic snapshots on the owner's schedule and keeps only the newest of them.
// It checks every few minutes from when the server starts (instrumentation.ts), so snapshots keep
// being taken after a restart even before anyone signs in. It holds no state shared with requests:
// the schedule is read from the preferences each time and ZFS is the record of what exists.
const CHECK_EVERY_MS = 5 * 60_000;
const FIRST_CHECK_MS = 60_000;
const INTERVALS = { hourly: 60 * 60_000, daily: 24 * 60 * 60_000 };
// A snapshot is due slightly early, so checks every few minutes don't drift it later each time.
const EARLY_MS = 2 * 60_000;
let started = false;
let running: Promise<{ created: Snapshot | null; deleted: string[] }> | null = null;

export function runSnapshotSchedule(now = Date.now()) {
  running ??= (async () => {
    try {
      const schedule = (await getPreferences()).snapshotSchedule;
      if (schedule.frequency === "off" || !(await snapshotSupport()).available) return { created: null, deleted: [] };
      const automatic = (await listSnapshots(true)).filter((snapshot) => snapshot.kind === "auto");
      let created: Snapshot | null = null;
      if (!automatic[0] || now - Date.parse(automatic[0].createdAt) >= INTERVALS[schedule.frequency] - EARLY_MS) {
        created = await createSnapshot("auto", new Date(now));
        automatic.unshift(created);
        await audit("snapshots.create", { name: created.name, scheduled: true });
      }
      const deleted: string[] = [];
      for (const old of automatic.slice(schedule.keep)) {
        await deleteSnapshot(old.name);
        deleted.push(old.name);
      }
      if (deleted.length) await audit("snapshots.prune", { names: deleted, keep: schedule.keep });
      return { created, deleted };
    } finally {
      running = null;
    }
  })();
  return running;
}

function scheduledRun() {
  void runSnapshotSchedule().catch((error: unknown) => console.error("Scheduled snapshot failed", error));
}

export function startSnapshotSchedule() {
  if (started) return;
  started = true;
  setTimeout(scheduledRun, FIRST_CHECK_MS).unref();
  setInterval(scheduledRun, CHECK_EVERY_MS).unref();
}
