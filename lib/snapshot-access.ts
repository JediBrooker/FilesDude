import { AppError } from "./http";
import { getPreferences } from "./preferences";
import type { Role } from "./scope";

// Snapshots are reached by path: an account browsing its folder in a snapshot sees whatever was
// at that path when the snapshot was taken, even things since moved out of its reach. So only the
// owner sees snapshots unless the owner chooses to share them with editors, or with everyone.
export async function canUseSnapshots(role: Role) {
  if (role === "owner") return true;
  const access = (await getPreferences()).snapshotAccess;
  return access === "everyone" || (access === "editors" && role === "editor");
}

export async function assertSnapshotAccess(role: Role) {
  if (!(await canUseSnapshots(role))) throw new AppError("The owner hasn't shared snapshots with your account", 403, "FORBIDDEN");
}

// Looking through snapshots mounts each one, so each account runs only a couple of these at once.
const MAX_ACTIVE_PER_ACCOUNT = 2;
const active = new Map<string, number>();

export async function withSnapshotSlot<T>(accountKey: string, work: () => Promise<T>) {
  const running = active.get(accountKey) ?? 0;
  if (running >= MAX_ACTIVE_PER_ACCOUNT) throw new AppError("Still looking through snapshots; try again in a moment", 503, "SNAPSHOTS_BUSY");
  active.set(accountKey, running + 1);
  try {
    return await work();
  } finally {
    const left = (active.get(accountKey) ?? 1) - 1;
    if (left > 0) active.set(accountKey, left);
    else active.delete(accountKey);
  }
}
