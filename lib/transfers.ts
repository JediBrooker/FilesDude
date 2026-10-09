import path from "node:path";
import { audit } from "./audit";
import { rewriteFavoritePaths } from "./favorites";
import { copyOrMove, type CopiedItems } from "./files";
import { startJob } from "./jobs";
import { rewriteSharePaths } from "./shares";

/** Favourites and share links follow items that are renamed or moved, and drop deleted ones. */
export async function rewriteLinkedPaths(changes: Array<{ from: string; to?: string }>, username: string, copies?: CopiedItems) {
  if (!changes.length) return;
  await rewriteFavoritePaths(changes);
  const revoked = await rewriteSharePaths(changes, copies);
  if (revoked.length) await audit("share.revoke", { username, ids: revoked, reason: "item deleted" });
}

/**
 * Starts copying or moving items as a background job. Each moved item's favourites and share links
 * are updated as soon as it is in place, and the outcome is audited when the job ends. `awaited`
 * marks a job a request waits for, which has its own allowance.
 */
export function startTransferJob(username: string, action: "copy" | "move", paths: string[], destination: string, awaited = false) {
  const move = action === "move";
  const subject = paths.length === 1 ? path.posix.basename(paths[0]) : `${paths.length} items`;
  return startJob(action, `${move ? "Moving" : "Copying"} ${subject}`, { done: 0, unit: move ? "entries" : "bytes" },
    (report, signal) => copyOrMove(paths, destination, move, {
      report,
      signal,
      moved: (item, copies) => rewriteLinkedPaths([{ from: item.source, to: item.path }], username, copies),
    }),
    async (job) => {
      await audit(`fs.${action}`, { username, paths, destination, status: job.status, transferred: job.transferred?.length ?? 0, error: job.error });
    },
    { awaited });
}
