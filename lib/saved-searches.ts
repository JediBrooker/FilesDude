import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { normalizeRelative } from "./files";
import { AppError } from "./http";
import { SEARCH_KINDS, type SearchKind } from "./name-search";
import { currentScope, withinScope } from "./scope";
import { findUserById } from "./users";

// Searches saved to run again: what was looked for (names or contents), with which filters, and
// in which folder. Kept per account, like favourites: { accounts: { owner: [...], <id>: [...] } }.

export interface SavedSearch {
  id: string;
  name: string;
  /** The folder searched (and everything inside it). */
  folder: string;
  query: string;
  mode: "names" | "contents";
  matchCase: boolean;
  kind: SearchKind;
  modifiedDays: number;
  minBytes: number;
  createdAt: string;
}

const MAX_SEARCHES = 50;
/** Including searches hidden because the account's folder changed; the oldest hidden ones go first. */
const MAX_STORED = 200;
let mutationQueue: Promise<void> = Promise.resolve();

const searchesFile = () => path.join(config.stateDir, "saved-searches.json");
const accountKey = () => currentScope()?.accountKey ?? "owner";

const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** A saved search as given, checked field by field (or an error saying what's wrong). */
export function checkSearch(value: unknown): Omit<SavedSearch, "id" | "createdAt"> {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name.replace(CONTROL, "").trim() : "";
  if (!name || name.length > 80) throw new AppError("Give the search a name of up to 80 characters", 400, "INVALID_NAME");
  if (typeof item.folder !== "string" || item.folder.length > 1024 || /\p{Cc}/u.test(item.folder)) throw new AppError("The folder is invalid", 400, "INVALID_PATH");
  const folder = normalizeRelative(item.folder);
  if (!withinScope(folder)) throw new AppError("That folder is outside your folder", 403, "OUTSIDE_SCOPE");
  const query = typeof item.query === "string" ? item.query.trim() : "";
  if (query.length > 256) throw new AppError("The search text is too long", 400, "INVALID_QUERY");
  const mode = item.mode === "contents" ? "contents" : item.mode === "names" ? "names" : null;
  if (!mode) throw new AppError("Choose names or contents", 400, "INVALID_MODE");
  const kind = (item.kind ?? "any") as SearchKind;
  if (!SEARCH_KINDS.includes(kind)) throw new AppError("Unknown kind of item", 400, "INVALID_FILTER");
  const number = (raw: unknown, max: number) => {
    const parsed = raw === undefined ? 0 : raw;
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0 || parsed > max) throw new AppError("A filter is invalid", 400, "INVALID_FILTER");
    return Math.floor(parsed);
  };
  const modifiedDays = number(item.modifiedDays, 36_500);
  const minBytes = number(item.minBytes, 2 ** 53);
  if (typeof item.matchCase !== "undefined" && typeof item.matchCase !== "boolean") throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
  // A search needs something to look for: text, or (by name) a filter.
  if (!query && (mode === "contents" || (kind === "any" && !modifiedDays && !minBytes))) throw new AppError("There's nothing to search for", 400, "EMPTY_SEARCH");
  return { name, folder, query, mode, matchCase: mode === "contents" && item.matchCase === true, kind: mode === "names" ? kind : "any", modifiedDays: mode === "names" ? modifiedDays : 0, minBytes: mode === "names" ? minBytes : 0 };
}

function validList(value: unknown): SavedSearch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SavedSearch[] => {
    try {
      const { id, createdAt } = item as { id?: unknown; createdAt?: unknown };
      if (typeof id !== "string" || typeof createdAt !== "string") return [];
      // Checked as given, but without the account's folder (a stored search outside it is hidden later).
      return [{ ...checkStored(item), id, createdAt }];
    } catch {
      return [];
    }
  });
}

// The stored fields, trusted as far as their shape (the folder is checked against the account when listed).
function checkStored(item: unknown): Omit<SavedSearch, "id" | "createdAt"> {
  const value = item as Record<string, unknown>;
  if (typeof value.name !== "string" || typeof value.folder !== "string" || typeof value.query !== "string" || (value.mode !== "names" && value.mode !== "contents")) throw new Error("invalid");
  if (!SEARCH_KINDS.includes(value.kind as SearchKind) || typeof value.modifiedDays !== "number" || typeof value.minBytes !== "number") throw new Error("invalid");
  return { name: value.name, folder: value.folder, query: value.query, mode: value.mode, matchCase: value.matchCase === true, kind: value.kind as SearchKind, modifiedDays: value.modifiedDays, minBytes: value.minBytes };
}

// A damaged file reads as empty. Inside the queue (`repair`), where nothing else is writing, it's
// kept aside for a look and the next write starts afresh.
async function readAll(repair = false): Promise<Record<string, SavedSearch[]>> {
  const file = searchesFile();
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { accounts?: Record<string, unknown> } | null;
    const accounts = parsed && typeof parsed === "object" ? parsed.accounts : undefined;
    return Object.fromEntries(Object.entries(accounts ?? {}).map(([key, list]) => [key, validList(list)]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!(error instanceof SyntaxError)) throw error;
    if (repair) {
      console.error("saved-searches.json couldn't be read; it was kept as saved-searches.json.bad");
      await fs.rename(file, `${file}.bad`).catch(() => undefined);
    }
    return {};
  }
}

async function writeAll(all: Record<string, SavedSearch[]>) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `saved-searches-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ accounts: all }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, searchesFile());
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function mutate<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** The account's saved searches (those in folders outside its folder now are hidden, not deleted). */
export async function listSavedSearches() {
  return ((await readAll())[accountKey()] ?? []).filter((search) => withinScope(search.folder));
}

/** Saves a search; a visible one with the same name is replaced. */
export async function saveSearch(value: unknown) {
  const account = accountKey();
  return mutate(async () => {
    // Checked in turn with renames (which move saved folders), so the folder is the current one.
    const search = checkSearch(value);
    // An account removed since its request began saves nothing.
    if (account !== "owner" && !(await findUserById(account))) throw new AppError("Your account has changed. Sign in again.", 401, "AUTH_REQUIRED");
    const all = await readAll(true);
    const stored = all[account] ?? [];
    const sameName = (item: SavedSearch) => withinScope(item.folder) && item.name.toLocaleLowerCase() === search.name.toLocaleLowerCase();
    const visible = stored.filter((item) => withinScope(item.folder) && !sameName(item));
    if (visible.length >= MAX_SEARCHES) throw new AppError(`Up to ${MAX_SEARCHES} searches can be saved`, 400, "TOO_MANY_SEARCHES");
    // Searches hidden by a change of folder are kept (they're back if it changes back), up to a point.
    const hidden = stored.filter((item) => !withinScope(item.folder)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(0, MAX_STORED - visible.length - 1));
    const list = [...visible, ...hidden, { ...search, id: crypto.randomUUID(), createdAt: new Date().toISOString() }];
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    await writeAll({ ...all, [account]: list });
    return list.filter((item) => withinScope(item.folder));
  });
}

export async function deleteSavedSearch(id: string) {
  const account = accountKey();
  return mutate(async () => {
    const all = await readAll(true);
    // Only a visible search can be deleted, since only those are shown.
    const list = (all[account] ?? []).filter((item) => item.id !== id || !withinScope(item.folder));
    await writeAll({ ...all, [account]: list });
    return list.filter((item) => withinScope(item.folder));
  });
}

/** Removes an account's saved searches when the account is removed. */
export async function forgetAccountSearches(account: string) {
  return mutate(async () => {
    const all = await readAll(true);
    if (!Object.hasOwn(all, account)) return;
    delete all[account];
    await writeAll(all);
  });
}

/** Searches in folders that are renamed or moved follow them; those in deleted folders go. */
export async function rewriteSearchFolders(changes: Array<{ from: string; to?: string }>) {
  return mutate(async () => {
    const normalized = changes.map((change) => ({ from: normalizeRelative(change.from), to: change.to === undefined ? undefined : normalizeRelative(change.to) }));
    const all = await readAll(true);
    let changed = false;
    const updated = Object.fromEntries(Object.entries(all).map(([key, list]) => [key, list.flatMap((search) => {
      const change = normalized.find((item) => item.from && (search.folder === item.from || search.folder.startsWith(`${item.from}/`)));
      if (!change) return [search];
      changed = true;
      if (change.to === undefined) return [];
      return [{ ...search, folder: [change.to, search.folder.slice(change.from.length).replace(/^\//, "")].filter(Boolean).join("/") }];
    })]));
    if (changed) await writeAll(updated);
  });
}
