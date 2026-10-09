import path from "node:path";
import { audit } from "./audit";
import { rewriteFavoritePaths } from "./favorites";
import { copyOrMove } from "./files";
import { startJob } from "./jobs";
import { rewriteSharePaths } from "./shares";

/** Favourites and share links follow items that are renamed or moved, and drop deleted ones. */
export async function rewriteLinkedPaths(changes: Array<{ from: string; to?: string }>, username: string) {
  if (!changes.length) return;
  await rewriteFavoritePaths(changes);
  const revoked = await rewriteSharePaths(changes);
  if (revoked.length) await audit("share.revoke", { username, ids: revoked, reason: "item deleted" });
}

/**
 * Starts copying or moving items as a background job. When it finishes, moved items' favourites and
 * share links are updated (including items moved before a failure) and the outcome is audited.
 */
export function startTransferJob(username: string, action: "copy" | "move", paths: string[], destination: string) {
  const move = action === "move";
  const subject = paths.length === 1 ? path.posix.basename(paths[0]) : `${paths.length} items`;
  return startJob(action, `${move ? "Moving" : "Copying"} ${subject}`, { done: 0, unit: move ? "entries" : "bytes" },
    (report, signal) => copyOrMove(paths, destination, move, { report, signal }),
    async (job) => {
      const transferred = job.transferred ?? [];
      if (move) await rewriteLinkedPaths(transferred.map((item) => ({ from: item.source, to: item.path })), username);
      await audit(`fs.${action}`, { username, paths, destination, status: job.status, transferred: transferred.length, error: job.error });
    });
}
