import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { getMime, normalizeRelative, openVerifiedFile, relativeFromAbsolute, safeResolve } from "./files";
import { AppError } from "./http";
import { scopeRoot, withinScope } from "./scope";
import { listUsers } from "./users";

// Where each account got to in each video (and audiobook), so it carries on from there, on any
// device. Kept per account (the last 300), by path; a video watched to the end is marked watched.
// Audio is only remembered when it's long (audiobooks, not songs). Positions
// arrive every few seconds while videos play, so they're kept in memory and written out at most
// every few seconds (a restart may lose the last few).
const MAX_PER_ACCOUNT = 300;
const MAX_ACCOUNTS = 1_000;
const WRITE_DELAY_MS = 5_000;
/** A video's position isn't recorded again sooner than this (unless it has just been finished). */
const SAVE_INTERVAL_MS = 3_000;
/** Played less than this isn't worth carrying on from. */
const MIN_POSITION = 30;
/** Within this much of the end (or 95%) counts as watched. */
const END_SECONDS = 120;
/** Audio shorter than this (a song) isn't worth carrying on from. */
const MIN_AUDIO_SECONDS = 600;

const isMedia = (relative: string) => /^(video|audio)\//.test(getMime(relative));

export type WatchEntry = { path: string; position: number; duration: number; watched: boolean; updatedAt: string };
type Store = Record<string, WatchEntry[]>;

const storeFile = () => path.join(config.stateDir, "watching.json");

const isEntry = (item: unknown): item is WatchEntry => {
  const entry = item as WatchEntry;
  return Boolean(entry) && typeof entry === "object" && typeof entry.path === "string" && Number.isFinite(entry.position) && Number.isFinite(entry.duration) && typeof entry.watched === "boolean" && typeof entry.updatedAt === "string";
};

/** Only well-formed entries are kept from the file. */
function checkedStore(parsed: unknown): Store {
  const store: Store = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return store;
  for (const [account, list] of Object.entries(parsed)) {
    if (Array.isArray(list)) store[account] = list.filter(isEntry).slice(0, MAX_PER_ACCOUNT);
  }
  return store;
}

let loaded: { file: string; store: Store } | null = null;
let unsaved = false;
let writeTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Runs one at a time, in order. */
function serial<T>(run: () => Promise<T>) {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

async function load(): Promise<Store> {
  const file = storeFile();
  if (loaded?.file === file) return loaded.store;
  let store: Store = {};
  try {
    store = checkedStore(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      // A damaged file is kept aside for a look rather than quietly overwritten.
      console.error("watching.json couldn't be read; it was kept as watching.json.bad");
      await fs.rename(file, `${file}.bad`).catch(() => undefined);
    } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  loaded = { file, store };
  unsaved = false;
  return store;
}

const readStore = () => serial(load);

function mutate<T>(change: (store: Store) => { store: Store | null; result: T }) {
  return serial(async () => {
    const { store, result } = change(await load());
    if (store) {
      loaded = { file: storeFile(), store };
      unsaved = true;
      if (!writeTimer) {
        writeTimer = setTimeout(() => {
          writeTimer = null;
          flushWatching().catch((error: Error) => console.error("watching.json couldn't be saved:", error.message));
        }, WRITE_DELAY_MS);
        writeTimer.unref();
      }
    }
    return result;
  });
}

/** Writes out positions not yet saved (on a timer; straight away when an account is removed). */
export function flushWatching() {
  return serial(async () => {
    if (!unsaved || !loaded || loaded.file !== storeFile()) return;
    unsaved = false;
    // History of accounts removed since (a save that was on its way as one was) goes.
    const accounts = new Set(["owner", ...(await listUsers()).map((user) => user.id)]);
    const store = Object.fromEntries(Object.entries(loaded.store).filter(([account]) => accounts.has(account)));
    loaded.store = store;
    const temporary = `${loaded.file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(store));
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

const isFinished = (position: number, duration: number) => duration > 0 && (position >= duration - END_SECONDS || position >= duration * 0.95);

/**
 * A video or audio path the account can reach (nothing is read from it); to record a position, it
 * must be one that's there.
 */
async function videoPath(raw: unknown, mustExist: boolean) {
  if (typeof raw !== "string" || raw.length > 4096) throw new AppError("Choose a video", 400, "INVALID_PATH");
  const relative = normalizeRelative(raw).replace(/\/+$/, "");
  if (!relative || !isMedia(relative)) throw new AppError("Only videos and audio are remembered", 400, "NOT_A_VIDEO");
  const missing = () => new AppError("That video isn't there", 404, "NOT_FOUND");
  let resolved: string;
  try {
    resolved = await safeResolve(relative, { mustExist });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw missing();
  }
  if (mustExist && !(await fs.stat(resolved).then((stat) => stat.isFile(), () => false))) throw missing();
  return relative;
}

/** Where this account got to in this video, if anywhere worth carrying on from. */
export async function watchPosition(accountKey: string, raw: unknown) {
  const relative = await videoPath(raw, false);
  const entry = (await readStore())[accountKey]?.find((item) => item.path === relative);
  return entry ?? null;
}

/** Records where the account is in a video (sent every few seconds while it plays). */
export async function saveWatchPosition(accountKey: string, raw: unknown, rawPosition: unknown, rawDuration: unknown) {
  const relative = await videoPath(raw, true);
  const position = Number(rawPosition);
  const duration = Number(rawDuration);
  if (!Number.isFinite(position) || position < 0 || position > 1e6 || !Number.isFinite(duration) || duration < 0 || duration > 1e6) throw new AppError("The position is invalid", 400, "INVALID_POSITION");
  return mutate((store) => {
    const list = store[accountKey] ?? [];
    const previous = list.find((item) => item.path === relative);
    const watched = isFinished(position, duration) || Boolean(previous?.watched && position < MIN_POSITION);
    // Nothing worth keeping yet for a video just started (unless it was watched before), or a song.
    if (!previous && position < MIN_POSITION) return { store: null, result: null };
    if (getMime(relative).startsWith("audio/") && duration < MIN_AUDIO_SECONDS) return { store: null, result: null };
    if (previous && previous.watched === watched && Date.now() - Date.parse(previous.updatedAt) < SAVE_INTERVAL_MS) return { store: null, result: previous };
    const entry: WatchEntry = { path: relative, position: isFinished(position, duration) ? 0 : Math.round(position), duration: Math.round(duration), watched, updatedAt: new Date().toISOString() };
    const next = [entry, ...list.filter((item) => item.path !== relative)].slice(0, MAX_PER_ACCOUNT);
    const accounts = Object.keys(store);
    if (!store[accountKey] && accounts.length >= MAX_ACCOUNTS) delete store[accounts[0]];
    return { store: { ...store, [accountKey]: next }, result: entry };
  });
}

/** Forgets a video ("start over"), or all of them. */
export async function forgetWatching(accountKey: string, raw?: unknown) {
  const relative = raw === undefined ? null : await videoPath(raw, false);
  return mutate((store) => {
    if (!store[accountKey]) return { store: null, result: undefined };
    const next = relative === null ? [] : store[accountKey].filter((item) => item.path !== relative);
    return { store: { ...store, [accountKey]: next }, result: undefined };
  });
}

export type ContinueEntry = WatchEntry & { name: string; size: number; modified: string; mime: string };

/**
 * Videos this account is part-way through, most recent first, within its folder. Videos since
 * moved or deleted are left out.
 */
export async function continueWatching(accountKey: string) {
  const root = scopeRoot();
  const found: ContinueEntry[] = [];
  for (const item of (await readStore())[accountKey] ?? []) {
    if (found.length >= 50) break;
    if (item.watched || item.position < MIN_POSITION || !withinScope(item.path, root)) continue;
    // Opened and checked, so a folder swapped for a link on the way can't show what's elsewhere.
    const opened = await openVerifiedFile(item.path).catch(() => null);
    if (!opened) continue;
    await opened.handle.close().catch(() => undefined);
    const { stat } = opened;
    if (!stat.isFile() || !withinScope(relativeFromAbsolute(opened.openedPath), root)) continue;
    found.push({ ...item, name: path.posix.basename(item.path), size: stat.size, modified: stat.mtime.toISOString(), mime: getMime(item.path) });
  }
  return found;
}

/** Watched or part-watched videos in a folder, for marking them in the list. */
export async function watchingIn(accountKey: string, folder: string) {
  const root = scopeRoot();
  const prefix = normalizeRelative(folder).replace(/\/+$/, "");
  return ((await readStore())[accountKey] ?? []).filter((item) => withinScope(item.path, root) && (prefix ? item.path.startsWith(`${prefix}/`) : true) && !item.path.slice(prefix ? prefix.length + 1 : 0).includes("/"));
}

/** Removes an account's entries when the account is removed. */
export async function forgetAccountWatching(accountKey: string) {
  await mutate((store) => {
    if (!store[accountKey]) return { store: null, result: undefined };
    const { [accountKey]: _removed, ...rest } = store;
    void _removed;
    return { store: rest, result: undefined };
  });
  await flushWatching();
}
