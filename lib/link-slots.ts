import { AppError } from "./http";
import { addressGroup } from "./upload-target";

// Uploads through upload links come from strangers, so only a few run at once: in all, per link, and
// per sender (IPv6 counted by /64). Both kinds share these slots, a file sent in one request and one
// sent in pieces. A slot is claimed before anything is waited on, so requests arriving together
// can't all pass the check, and given back when the upload ends.
const MAX_TOTAL = 8;
const MAX_PER_LINK = 3;
const MAX_PER_ADDRESS = 3;

let total = 0;
const byLink = new Map<string, number>();
const byAddress = new Map<string, number>();

function adjust(counts: Map<string, number>, key: string, change: number) {
  const next = (counts.get(key) ?? 0) + change;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

/** Claims a slot for an upload through a link, or refuses; returns the function that gives it back. */
export function claimLinkSlot(shareId: string, address: string) {
  const group = addressGroup(address);
  if (total >= MAX_TOTAL) throw new AppError("The server is busy with other uploads. Try again in a minute.", 503, "BUSY");
  if ((byLink.get(shareId) ?? 0) >= MAX_PER_LINK) throw new AppError("This link is busy with other uploads. Try again in a minute.", 503, "BUSY");
  if ((byAddress.get(group) ?? 0) >= MAX_PER_ADDRESS) throw new AppError(`Upload at most ${MAX_PER_ADDRESS} files at a time`, 429, "TOO_MANY_UPLOADS");
  total += 1;
  adjust(byLink, shareId, 1);
  adjust(byAddress, group, 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    total -= 1;
    adjust(byLink, shareId, -1);
    adjust(byAddress, group, -1);
  };
}
