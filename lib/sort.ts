import type { FileEntry } from "./types";

export type SortKey = "name" | "size" | "owner" | "mode" | "modified";
export type SortDirection = "asc" | "desc";
export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortState = { key: "name", direction: "asc" };

// The direction a column starts in when first chosen: biggest and newest first.
export const INITIAL_DIRECTION: Record<SortKey, SortDirection> = {
  name: "asc",
  size: "desc",
  owner: "asc",
  mode: "asc",
  modified: "desc",
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareBy(key: SortKey, a: FileEntry, b: FileEntry) {
  switch (key) {
    case "name": return collator.compare(a.name, b.name);
    case "size": return a.size - b.size;
    case "owner": return collator.compare(`${a.owner}:${a.group}`, `${b.owner}:${b.group}`);
    case "mode": return Number.parseInt(a.mode, 8) - Number.parseInt(b.mode, 8);
    case "modified": return Date.parse(a.modified) - Date.parse(b.modified);
  }
}

/** Sorts a listing with folders first; ties fall back to natural name order. */
export function sortEntries(entries: FileEntry[], sort: SortState) {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const aFolder = a.type === "directory";
    if (aFolder !== (b.type === "directory")) return aFolder ? -1 : 1;
    // Folder sizes are not meaningful, so folders stay in name order when sorting by size.
    if (aFolder && sort.key === "size") return collator.compare(a.name, b.name);
    return compareBy(sort.key, a, b) * factor || collator.compare(a.name, b.name);
  });
}

/** Clicking the active column flips it; a new column starts in its natural direction. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: INITIAL_DIRECTION[key] };
}

export function parseSort(stored: string | null): SortState {
  try {
    const value = JSON.parse(stored || "null") as Partial<SortState> | null;
    if (value && typeof value.key === "string" && Object.hasOwn(INITIAL_DIRECTION, value.key) && (value.direction === "asc" || value.direction === "desc")) {
      return { key: value.key, direction: value.direction };
    }
  } catch {
    // Fall through to the default for unreadable stored values.
  }
  return DEFAULT_SORT;
}
