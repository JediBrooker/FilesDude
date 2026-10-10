import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { getMime, normalizeRelative, safeResolve } from "./files";
import { AppError } from "./http";
import { scopeRoot, withinScope } from "./scope";

// Where each account got to in each video, so it carries on from there, on any device. Kept per
// account (the last 300 videos), by path; a video watched to the end is marked watched.
const MAX_PER_ACCOUNT = 300;
const MAX_ACCOUNTS = 1_000;
/** Played less than this isn't worth carrying on from. */
const MIN_POSITION = 30;
/** Within this much of the end (or 95%) counts as watched. */
const END_SECONDS = 120;

export type WatchEntry = { path: string; position: number; duration: number; watched: boolean; updatedAt: string };
type Store = Record<string, WatchEntry[]>;

const storeFile = () => path.join(config.stateDir, "watching.json");

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

let queue: Promise<unknown> = Promise.resolve();

function mutate<T>(change: (store: Store) => { store: Store | null; result: T }) {
  const run = queue.then(async () => {
    const { store, result } = change(await readStore());
    if (store) {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${storeFile()}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(store), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, storeFile());
    }
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

const isFinished = (position: number, duration: number) => duration > 0 && (position >= duration - END_SECONDS || position >= duration * 0.95);

/** A video path the account can reach (it needn't be checked further: nothing is read from it). */
async function videoPath(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 4096) throw new AppError("Choose a video", 400, "INVALID_PATH");
  const relative = normalizeRelative(raw).replace(/\/+$/, "");
  if (!relative || !getMime(relative).startsWith("video/")) throw new AppError("Only videos are remembered", 400, "NOT_A_VIDEO");
  await safeResolve(relative, { mustExist: false });
  return relative;
}

/** Where this account got to in this video, if anywhere worth carrying on from. */
export async function watchPosition(accountKey: string, raw: unknown) {
  const relative = await videoPath(raw);
  const entry = (await readStore())[accountKey]?.find((item) => item.path === relative);
  return entry ?? null;
}

/** Records where the account is in a video (sent every few seconds while it plays). */
export async function saveWatchPosition(accountKey: string, raw: unknown, rawPosition: unknown, rawDuration: unknown) {
  const relative = await videoPath(raw);
  const position = Number(rawPosition);
  const duration = Number(rawDuration);
  if (!Number.isFinite(position) || position < 0 || position > 1e6 || !Number.isFinite(duration) || duration < 0 || duration > 1e6) throw new AppError("The position is invalid", 400, "INVALID_POSITION");
  return mutate((store) => {
    const list = store[accountKey] ?? [];
    const previous = list.find((item) => item.path === relative);
    const watched = isFinished(position, duration) || Boolean(previous?.watched && position < MIN_POSITION);
    // Nothing worth keeping yet for a video just started (unless it was watched before).
    if (!previous && position < MIN_POSITION) return { store: null, result: null };
    const entry: WatchEntry = { path: relative, position: isFinished(position, duration) ? 0 : Math.round(position), duration: Math.round(duration), watched, updatedAt: new Date().toISOString() };
    const next = [entry, ...list.filter((item) => item.path !== relative)].slice(0, MAX_PER_ACCOUNT);
    const accounts = Object.keys(store);
    if (!store[accountKey] && accounts.length >= MAX_ACCOUNTS) delete store[accounts[0]];
    return { store: { ...store, [accountKey]: next }, result: entry };
  });
}

/** Forgets a video ("start over"), or all of them. */
export async function forgetWatching(accountKey: string, raw?: unknown) {
  const relative = raw === undefined ? null : await videoPath(raw);
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
    const stat = await safeResolve(item.path).then((resolved) => fs.stat(resolved)).catch(() => null);
    if (!stat?.isFile()) continue;
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
  return mutate((store) => {
    if (!store[accountKey]) return { store: null, result: undefined };
    const { [accountKey]: _removed, ...rest } = store;
    void _removed;
    return { store: rest, result: undefined };
  });
}
