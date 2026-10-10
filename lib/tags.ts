import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { getMime, normalizeRelative, openVerifiedFile, relativeFromAbsolute, safeResolve } from "./files";
import { AppError } from "./http";
import { currentScope, scopeRoot, withinScope } from "./scope";

// Colour tags on files and folders, like Finder's. They're each account's own (like favourites),
// kept by path in tags.json in the state folder, and follow items that are renamed or moved (see
// transfers.ts). Paths are kept in Maps, and written as lists, never as object keys, since a file
// can be called anything ("__proto__" included).

export const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
/** Items one account can tag. */
const MAX_TAGGED = 10_000;
/** Items one request can tag at once. */
export const MAX_TAG_PATHS = 1_000;
/** Items listed for one colour. */
const MAX_LISTED = 500;

type AccountTags = Map<string, TagColor[]>;
type Store = Map<string, AccountTags>;

const storeFile = () => path.join(config.stateDir, "tags.json");
const accountKey = () => currentScope()?.accountKey ?? "owner";
const isColor = (value: unknown): value is TagColor => typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);

async function readStore(): Promise<Store> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(storeFile(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    if (error instanceof SyntaxError) {
      // A damaged file is kept aside for a look rather than quietly overwritten.
      console.error("tags.json couldn't be read; it was kept as tags.json.bad");
      await fs.rename(storeFile(), `${storeFile()}.bad`).catch(() => undefined);
      return new Map();
    }
    throw error;
  }
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

async function writeStore(store: Store) {
  const accounts = Object.fromEntries([...store].filter(([, tags]) => tags.size).map(([account, tags]) => [account, [...tags]]));
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${storeFile()}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ accounts }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, storeFile());
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Changes run one at a time, each reading the file afresh. */
function mutate<T>(change: (store: Store) => { changed: boolean; result: T }) {
  const run = queue.then(async () => {
    const store = await readStore();
    const { changed, result } = change(store);
    if (changed) await writeStore(store);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
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

/** The items with this colour, wherever they are in the account's folder; ones since gone are left out. */
export async function taggedWith(color: unknown) {
  if (!isColor(color)) throw new AppError("Choose a tag colour", 400, "INVALID_TAG");
  const root = scopeRoot();
  const found: TaggedEntry[] = [];
  for (const [item, colors] of (await readStore()).get(accountKey()) ?? []) {
    if (found.length >= MAX_LISTED) break;
    if (!colors.includes(color) || !withinScope(item, root)) continue;
    // Opened and checked, so a folder swapped for a link on the way can't show what's elsewhere.
    const opened = await openVerifiedFile(item).catch(() => null);
    if (!opened) continue;
    await opened.handle.close().catch(() => undefined);
    const { stat } = opened;
    if ((!stat.isFile() && !stat.isDirectory()) || !withinScope(relativeFromAbsolute(opened.openedPath), root)) continue;
    const type = stat.isDirectory() ? "directory" : "file";
    found.push({ path: item, name: path.posix.basename(item), type, size: type === "file" ? stat.size : 0, modified: stat.mtime.toISOString(), mime: type === "file" ? getMime(item) : "inode/directory", colors });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Items to tag: ones that are there, in the account's folder (not the top of it). */
async function taggablePaths(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TAG_PATHS) throw new AppError(`Choose between 1 and ${MAX_TAG_PATHS} items`, 400, "INVALID_PATHS");
  const paths = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.length > 4096) throw new AppError("An item is invalid", 400, "INVALID_PATH");
    const relative = normalizeRelative(item).replace(/\/+$/, "");
    if (!relative || relative === scopeRoot()) throw new AppError("Your top folder can't be tagged", 400, "INVALID_PATH");
    try {
      await safeResolve(relative);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("An item isn't there any more", 404, "NOT_FOUND");
    }
    paths.add(relative);
  }
  return [...paths];
}

/** Adds a colour to items, or takes it off. Returns their tags now. */
export async function setTag(rawPaths: unknown, color: unknown, on: unknown) {
  if (!isColor(color)) throw new AppError("Choose a tag colour", 400, "INVALID_TAG");
  const paths = await taggablePaths(rawPaths);
  const account = accountKey();
  return mutate((store) => {
    const tags = store.get(account) ?? new Map<string, TagColor[]>();
    let changed = false;
    for (const item of paths) {
      const current = tags.get(item) ?? [];
      const next = on === true ? TAG_COLORS.filter((tag) => tag === color || current.includes(tag)) : current.filter((tag) => tag !== color);
      if (next.length === current.length) continue;
      if (!tags.has(item) && tags.size >= MAX_TAGGED) throw new AppError(`Up to ${MAX_TAGGED.toLocaleString()} items can be tagged`, 400, "TOO_MANY_TAGS");
      if (next.length) tags.set(item, next);
      else tags.delete(item);
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

/** Renames and moves carry every account's tags along; deletes drop them. */
export async function rewriteTagPaths(changes: Array<{ from: string; to?: string }>) {
  const normalized = changes.map((change) => ({ from: normalizeRelative(change.from), to: change.to === undefined ? undefined : normalizeRelative(change.to) }));
  return mutate((store) => {
    let changed = false;
    for (const [account, tags] of store) {
      const next: AccountTags = new Map();
      for (const [item, colors] of tags) {
        const change = normalized.find((candidate) => item === candidate.from || item.startsWith(`${candidate.from}/`));
        if (!change) {
          next.set(item, colors);
          continue;
        }
        changed = true;
        if (change.to === undefined) continue;
        next.set([change.to, item.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/"), colors);
      }
      store.set(account, next);
    }
    return { changed, result: undefined };
  });
}

/** Removes an account's tags when the account is removed. */
export async function forgetAccountTags(account: string) {
  return mutate((store) => ({ changed: store.delete(account), result: undefined }));
}
