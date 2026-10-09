// Runs once when the server starts. Only work that shares no in-memory state with requests belongs
// here: Next bundles this file separately, with its own copies of the app's modules.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSnapshotSchedule } = await import("./lib/snapshot-schedule");
  startSnapshotSchedule();
}
