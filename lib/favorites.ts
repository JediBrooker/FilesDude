import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { safeResolve, normalizeRelative } from "./files";
import { AppError } from "./http";

export interface FavoriteLocation {
  path: string;
  name: string;
  createdAt: string;
}

const directory = config.stateDir;
const favoritesFile = path.join(directory, "favorites.json");
let mutationQueue: Promise<void> = Promise.resolve();

async function readStoredFavorites(): Promise<FavoriteLocation[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(favoritesFile, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FavoriteLocation =>
      Boolean(item) && typeof item.path === "string" && typeof item.name === "string" && typeof item.createdAt === "string",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw new AppError("Favourite locations data is corrupted", 500, "FAVORITES_CORRUPT");
    throw error;
  }
}

async function writeStoredFavorites(favorites: FavoriteLocation[]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `favorites-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(favorites, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, favoritesFile);
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

export async function rewriteFavoritePaths(changes: Array<{ from: string; to?: string }>) {
  return mutate(async () => {
    const normalized = changes.map((change) => ({
      from: normalizeRelative(change.from),
      to: change.to === undefined ? undefined : normalizeRelative(change.to),
    }));
    const favorites = await readStoredFavorites();
    const updated = favorites.flatMap((favorite) => {
      const change = normalized.find((item) => favorite.path === item.from || favorite.path.startsWith(`${item.from}/`));
      if (!change) return [favorite];
      if (change.to === undefined) return [];
      const suffix = favorite.path.slice(change.from.length).replace(/^\//, "");
      const nextPath = [change.to, suffix].filter(Boolean).join("/");
      return [{ ...favorite, path: nextPath, name: suffix ? favorite.name : path.posix.basename(change.to) }];
    });
    if (JSON.stringify(updated) !== JSON.stringify(favorites)) await writeStoredFavorites(updated);
    return updated;
  });
}
