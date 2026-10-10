// Runs once when the server starts. Only work that shares no in-memory state with requests belongs
// here: Next bundles this file separately, with its own copies of the app's modules.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Before any request is served: records each connection's real address (see lib/peer.ts).
  const { installPeerStamp } = await import("./lib/peer");
  installPeerStamp();
  // Reading the preferences sets the request timeout to match the uploads setting.
  const { getPreferences } = await import("./lib/preferences");
  await getPreferences().catch((error: unknown) => console.error("Could not read preferences", error));
  // Tells the owner (if notifications are on) when the disk is nearly full.
  const { startFreeSpaceChecks } = await import("./lib/notifications");
  startFreeSpaceChecks();
  const { startSnapshotSchedule } = await import("./lib/snapshot-schedule");
  startSnapshotSchedule();
}
