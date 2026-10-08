import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { safeResolve, normalizeRelative } from "./files";
import { AppError } from "./http";
import { currentScope } from "./scope";

export interface FavoriteLocation {
  path: string;
  name: string;
  createdAt: string;
}

// Favourites are kept per account: { accounts: { owner: [...], <account id>: [...] } }.
// A file from before accounts existed (a plain list) belongs to the owner.
type FavoritesByAccount = Record<string, FavoriteLocation[]>;
let mutationQueue: Promise<void> = Promise.resolve();

function favoritesFile() {
  return path.join(config.stateDir, "favorites.json");
}

function accountKey() {
  return currentScope()?.accountKey ?? "owner";
}

function validList(value: unknown): FavoriteLocation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is FavoriteLocation =>
    Boolean(item) && typeof item.path === "string" && typeof item.name === "string" && typeof item.createdAt === "string",
  );
}

async function readAllFavorites(): Promise<FavoritesByAccount> {
  try {
    const parsed = JSON.parse(await fs.readFile(favoritesFile(), "utf8"));
    if (Array.isArray(parsed)) return { owner: validList(parsed) };
    const accounts = parsed && typeof parsed === "object" ? (parsed as { accounts?: Record<string, unknown> }).accounts : undefined;
    return Object.fromEntries(Object.entries(accounts ?? {}).map(([key, list]) => [key, validList(list)]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new AppError("Favourite locations data is corrupted", 500, "FAVORITES_CORRUPT");
    throw error;
  }
}

async function writeAllFavorites(favorites: FavoritesByAccount) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `favorites-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({ accounts: favorites }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, favoritesFile());
}

async function readStoredFavorites(): Promise<FavoriteLocation[]> {
  return (await readAllFavorites())[accountKey()] ?? [];
}

async function writeStoredFavorites(favorites: FavoriteLocation[]) {
  const all = await readAllFavorites();
  await writeAllFavorites({ ...all, [accountKey()]: favorites });
}

function mutate<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function listFavorites() {
  return readStoredFavorites();
}

export async function addFavorite(relativePath: string) {
  return mutate(async () => {
    const normalized = normalizeRelative(relativePath);
    if (!normalized) throw new AppError("The root location is already available in navigation", 400, "ROOT_FAVORITE");
    const absolute = await safeResolve(normalized);
    if (!(await fs.stat(absolute)).isDirectory()) throw new AppError("Only folders can be added to favourites", 400, "NOT_A_DIRECTORY");
    const favorites = await readStoredFavorites();
    if (!favorites.some((favorite) => favorite.path === normalized)) {
      favorites.push({ path: normalized, name: path.basename(absolute), createdAt: new Date().toISOString() });
      await writeStoredFavorites(favorites);
    }
    return favorites;
  });
}

export async function removeFavorite(relativePath: string) {
  return mutate(async () => {
    const normalized = normalizeRelative(relativePath);
    const favorites = (await readStoredFavorites()).filter((favorite) => favorite.path !== normalized);
    await writeStoredFavorites(favorites);
    return favorites;
  });
}

/** Renames, moves, and deletes update every account's favourites, not just the current one's. */
export async function rewriteFavoritePaths(changes: Array<{ from: string; to?: string }>) {
  return mutate(async () => {
    const normalized = changes.map((change) => ({
      from: normalizeRelative(change.from),
      to: change.to === undefined ? undefined : normalizeRelative(change.to),
    }));
    const rewrite = (favorites: FavoriteLocation[]) => favorites.flatMap((favorite) => {
      const change = normalized.find((item) => favorite.path === item.from || favorite.path.startsWith(`${item.from}/`));
      if (!change) return [favorite];
      if (change.to === undefined) return [];
      const suffix = favorite.path.slice(change.from.length).replace(/^\//, "");
      const nextPath = [change.to, suffix].filter(Boolean).join("/");
      return [{ ...favorite, path: nextPath, name: suffix ? favorite.name : path.posix.basename(change.to) }];
    });
    const all = await readAllFavorites();
    const updated = Object.fromEntries(Object.entries(all).map(([key, list]) => [key, rewrite(list)]));
    if (JSON.stringify(updated) !== JSON.stringify(all)) await writeAllFavorites(updated);
    return updated[accountKey()] ?? [];
  });
}
