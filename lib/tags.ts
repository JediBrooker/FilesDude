import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { getMime, isReservedLocation, normalizeRelative, openVerifiedFile, relativeFromAbsolute, safeResolve } from "./files";
import { AppError } from "./http";
import { currentScope, scopeRoot, withinScope } from "./scope";

// Colour tags on files and folders, like Finder's. They're each account's own (like favourites),
// kept by path in tags.json in the state folder, and follow items that are renamed or moved (see
// transfers.ts). Paths are kept in Maps, and written as lists, never as object keys, since a file
// can be called anything ("__proto__" included).
//
// Renames and moves update tags while holding the filesystem lock, so they must never wait on the
// disk: tags are kept in memory, changed there, and written out a moment later.

export const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
/** Items one account can tag (within its folder). */
const MAX_TAGGED = 10_000;
/** The total length of one account's tagged paths, so the file stays small. */
const MAX_TAGGED_BYTES = 2 * 1024 * 1024;
/** Items one request can tag at once. */
export const MAX_TAG_PATHS = 1_000;
/** Items listed for one colour, and items looked at to find them. */
const MAX_LISTED = 500;
const MAX_LOOKED_AT = 2_000;
const WRITE_DELAY_MS = 2_000;

type AccountTags = Map<string, TagColor[]>;
type Store = Map<string, AccountTags>;

const storeFile = () => path.join(config.stateDir, "tags.json");
const accountKey = () => currentScope()?.accountKey ?? "owner";
const isColor = (value: unknown): value is TagColor => typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);

function parseStore(parsed: unknown): Store {
  const store: Store = new Map();
  const accounts = parsed && typeof parsed === "object" ? (parsed as { accounts?: unknown }).accounts : undefined;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return store;
  for (const [account, list] of Object.entries(accounts)) {
    if (!Array.isArray(list)) continue;
    const tags: AccountTags = new Map();
    for (const item of list) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
      const colors = TAG_COLORS.filter((color) => (item[1] as unknown[]).includes(color));
      if (colors.length) tags.set(item[0], colors);
    }
    store.set(account, tags);
  }
  return store;
}

let loaded: { file: string; store: Store } | null = null;
let unsaved = false;
let writeTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Bumped whenever renames or deletes change paths, so a tag checked before one is checked again. */
let generation = 0;

/** Runs one at a time, in order. */
function serial<T>(run: () => Promise<T>) {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

/** The tags, read from the file the first time (only ever inside the queue). */
async function load(): Promise<Store> {
  const file = storeFile();
  if (loaded?.file === file) return loaded.store;
  let store: Store = new Map();
  try {
    store = parseStore(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      // A damaged file is kept aside for a look rather than quietly overwritten.
      console.error("tags.json couldn't be read; it was kept as tags.json.bad");
      await fs.rename(file, `${file}.bad`).catch(() => undefined);
    } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  loaded = { file, store };
  unsaved = false;
  return store;
}

const readStore = () => serial(load);

/** Changes the tags in memory, one change at a time; they're written out shortly after. */
function mutate<T>(change: (store: Store) => { changed: boolean; result: T } | Promise<{ changed: boolean; result: T }>) {
  return serial(async () => {
    const store = await load();
    const { changed, result } = await change(store);
    if (changed) {
      unsaved = true;
      if (!writeTimer) {
        writeTimer = setTimeout(() => {
          writeTimer = null;
          flushTags().catch((error: Error) => console.error("tags.json couldn't be saved:", error.message));
        }, WRITE_DELAY_MS);
        writeTimer.unref();
      }
    }
    return result;
  });
}

/** Writes out tag changes not yet saved (on a timer; straight away when an account is removed). */
export function flushTags() {
  return serial(async () => {
    if (!unsaved || !loaded || loaded.file !== storeFile()) return;
    unsaved = false;
    const accounts = Object.fromEntries([...loaded.store].filter(([, tags]) => tags.size).map(([account, tags]) => [account, [...tags]]));
    const temporary = `${loaded.file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ accounts }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, loaded.file);
    } catch (error) {
      unsaved = true;
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
}

const parentOf = (relative: string) => path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);

/** The tags on the items directly inside a folder (for marking them in the list). */
export async function tagsIn(folder: unknown) {
  const prefix = normalizeRelative(typeof folder === "string" ? folder : "").replace(/\/+$/, "");
  const root = scopeRoot();
  const tags = (await readStore()).get(accountKey()) ?? new Map();
  return [...tags].filter(([item]) => parentOf(item) === prefix && withinScope(item, root)).map(([item, colors]) => ({ path: item, colors }));
}

/** How many items have each colour (within the account's folder), for the sidebar. */
export async function tagCounts() {
  const root = scopeRoot();
  const counts = Object.fromEntries(TAG_COLORS.map((color) => [color, 0])) as Record<TagColor, number>;
  for (const [item, colors] of (await readStore()).get(accountKey()) ?? []) {
    if (!withinScope(item, root)) continue;
    for (const color of colors) counts[color] += 1;
  }
  return counts;
}

export type TaggedEntry = { path: string; name: string; type: "file" | "directory"; size: number; modified: string; mime: string; colors: TagColor[] };

const listing = new Set<string>();

/**
 * The items with this colour, wherever they are in the account's folder (one listing at a time per
 * account). Items that have gone are left out, and their tags dropped.
 */
export async function taggedWith(color: unknown) {
  if (!isColor(color)) throw new AppError("Choose a tag colour", 400, "INVALID_TAG");
  const account = accountKey();
  if (listing.has(account)) throw new AppError("Your tags are already being listed; try again in a moment", 429, "TAGS_BUSY");
  listing.add(account);
  try {
    const root = scopeRoot();
    const found: TaggedEntry[] = [];
    const gone: string[] = [];
    let lookedAt = 0;
    for (const [item, colors] of (await readStore()).get(account) ?? []) {
      if (found.length >= MAX_LISTED || lookedAt >= MAX_LOOKED_AT) break;
      if (!colors.includes(color) || !withinScope(item, root)) continue;
      lookedAt += 1;
      let absolute: string;
      try {
        absolute = await safeResolve(item);
      } catch (error) {
        if ((error as AppError).status === 404) gone.push(item);
        continue;
      }
      // Only files and folders are opened (never devices or pipes), and they're opened and checked,
      // so a folder swapped for a link on the way can't show what's elsewhere.
      const before = await fs.stat(absolute).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "gone" as const : null));
      if (before === "gone") gone.push(item);
      if (!before || before === "gone" || (!before.isFile() && !before.isDirectory())) continue;
      const opened = await openVerifiedFile(item).catch(() => null);
      if (!opened) continue;
      await opened.handle.close().catch(() => undefined);
      const { stat } = opened;
      if ((!stat.isFile() && !stat.isDirectory()) || stat.ino !== before.ino || !withinScope(relativeFromAbsolute(opened.openedPath), root) || (await isReservedLocation(opened.openedPath))) continue;
      const type = stat.isDirectory() ? "directory" : "file";
      found.push({ path: item, name: path.posix.basename(item), type, size: type === "file" ? stat.size : 0, modified: stat.mtime.toISOString(), mime: type === "file" ? getMime(item) : "inode/directory", colors });
    }
    if (gone.length) {
      await mutate((store) => {
        const tags = store.get(account);
        let changed = false;
        for (const item of gone) changed = Boolean(tags?.delete(item)) || changed;
        return { changed, result: undefined };
      });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  } finally {
    listing.delete(account);
  }
}

/** Items to tag: ones that are there, in the account's folder (not the top of it, nor FilesDude's own). */
async function taggablePaths(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TAG_PATHS) throw new AppError(`Choose between 1 and ${MAX_TAG_PATHS} items`, 400, "INVALID_PATHS");
  const paths = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.length > 4096) throw new AppError("An item is invalid", 400, "INVALID_PATH");
    const relative = normalizeRelative(item).replace(/\/+$/, "");
    if (!relative || relative === scopeRoot()) throw new AppError("Your top folder can't be tagged", 400, "INVALID_PATH");
    let absolute: string;
    try {
      absolute = await safeResolve(relative);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("An item isn't there any more", 404, "NOT_FOUND");
    }
    const real = await fs.realpath(absolute).catch(() => absolute);
    if (await isReservedLocation(real)) throw new AppError("That path is reserved by FilesDude", 403, "RESERVED_PATH");
    paths.add(relative);
  }
  return [...paths];
}

/** Adds a colour to items, or takes it off. Returns their tags now. */
export async function setTag(rawPaths: unknown, color: unknown, on: unknown) {
  if (!isColor(color)) throw new AppError("Choose a tag colour", 400, "INVALID_TAG");
  const checkedAt = generation;
  let paths = await taggablePaths(rawPaths);
  const account = accountKey();
  const root = scopeRoot();
  return mutate(async (store) => {
    // Items renamed or deleted since they were checked are checked again.
    if (generation !== checkedAt) paths = await taggablePaths(rawPaths);
    const tags = store.get(account) ?? new Map<string, TagColor[]>();
    let count = 0;
    let bytes = 0;
    for (const item of tags.keys()) {
      bytes += item.length;
      if (withinScope(item, root)) count += 1;
    }
    let changed = false;
    for (const item of paths) {
      const current = tags.get(item) ?? [];
      const next = on === true ? TAG_COLORS.filter((tag) => tag === color || current.includes(tag)) : current.filter((tag) => tag !== color);
      if (next.length === current.length) continue;
      if (!tags.has(item)) {
        if (count >= MAX_TAGGED) throw new AppError(`Up to ${MAX_TAGGED.toLocaleString()} items can be tagged`, 400, "TOO_MANY_TAGS");
        if (bytes + item.length > MAX_TAGGED_BYTES) throw new AppError("You've tagged as many items as can be kept", 400, "TOO_MANY_TAGS");
        count += 1;
        bytes += item.length;
      }
      if (next.length) tags.set(item, next);
      else {
        tags.delete(item);
        bytes -= item.length;
      }
      changed = true;
    }
    store.set(account, tags);
    return { changed, result: paths.map((item) => ({ path: item, colors: tags.get(item) ?? [] })) };
  });
}

/** Takes every tag off items. */
export async function clearTags(rawPaths: unknown) {
  if (!Array.isArray(rawPaths) || !rawPaths.length || rawPaths.length > MAX_TAG_PATHS) throw new AppError(`Choose between 1 and ${MAX_TAG_PATHS} items`, 400, "INVALID_PATHS");
  const root = scopeRoot();
  // Items that are gone can still be untagged; only the account's own folder is touched.
  const paths = rawPaths.map((item) => (typeof item === "string" && item.length <= 4096 ? normalizeRelative(item).replace(/\/+$/, "") : "")).filter((item) => item && withinScope(item, root));
  const account = accountKey();
  return mutate((store) => {
    const tags = store.get(account);
    if (!tags) return { changed: false, result: undefined };
    let changed = false;
    for (const item of paths) changed = tags.delete(item) || changed;
    return { changed, result: undefined };
  });
}

/** Renames and moves carry every account's tags along; deletes drop them. Quick: nothing waits on the disk. */
export async function rewriteTagPaths(changes: Array<{ from: string; to?: string }>) {
  const byFrom = new Map(changes.map((change) => [normalizeRelative(change.from), change.to === undefined ? undefined : normalizeRelative(change.to)] as const));
  // The change covering a path: one for it, or for the nearest folder above it.
  const changeFor = (item: string) => {
    for (let end = item.length; end > 0; end = item.lastIndexOf("/", end - 1)) {
      const from = item.slice(0, end);
      if (byFrom.has(from)) return { from, to: byFrom.get(from) };
    }
    return null;
  };
  return mutate((store) => {
    let changed = false;
    for (const [account, tags] of store) {
      const next: AccountTags = new Map();
      for (const [item, colors] of tags) {
        const change = changeFor(item);
        if (!change) {
          next.set(item, colors);
          continue;
        }
        changed = true;
        if (change.to === undefined) continue;
        next.set([change.to, item.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/"), colors);
      }
      if (changed) store.set(account, next);
    }
    if (changed) generation += 1;
    return { changed, result: undefined };
  });
}

/** Removes an account's tags when the account is removed. */
export async function forgetAccountTags(account: string) {
  await mutate((store) => ({ changed: store.delete(account), result: undefined }));
  await flushTags();
}
