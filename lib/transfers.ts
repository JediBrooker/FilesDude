import path from "node:path";
import { audit } from "./audit";
import { rewriteFavoritePaths } from "./favorites";
import { rewriteSearchFolders } from "./saved-searches";
import { copyOrMove, type CopiedItems } from "./files";
import { startJob } from "./jobs";
import { rewriteSharePaths } from "./shares";
import { rewriteTagPaths } from "./tags";

/**
 * Share links, favourites, and tags follow items that are renamed or moved, and drop deleted ones.
 * Share links come first (they decide what strangers can reach), and favourites or tags failing to
 * update never stops the rest, or the change itself, from going through.
 */
export async function rewriteLinkedPaths(changes: Array<{ from: string; to?: string }>, username: string, copies?: CopiedItems) {
  if (!changes.length) return;
  const revoked = await rewriteSharePaths(changes, copies);
  if (revoked.length) await audit("share.revoke", { username, ids: revoked, reason: "item deleted" });
  await rewriteFavoritePaths(changes).catch((error: Error) => console.error("Favourites couldn't follow a change:", error.message));
  await rewriteSearchFolders(changes).catch((error: Error) => console.error("Saved searches couldn't follow a change:", error.message));
  await rewriteTagPaths(changes).catch((error: Error) => console.error("Tags couldn't follow a change:", error.message));
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
