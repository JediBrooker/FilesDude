import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "./files";
import { AppError } from "./http";

// Image decoding is CPU- and memory-heavy and shares libuv's small thread pool with file I/O, so
// sharp keeps no cache, uses one thread per image, and at most two thumbnails are made at once.
sharp.cache(false);
sharp.concurrency(1);

/** Formats thumbnails are made for. SVG is left out so no vector or script parser ever runs. */
export const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
export const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 100_000_000;
const THUMBNAIL_SIZE = 320;
const MAX_ACTIVE = 2;
const MAX_WAITING = 200;
const CACHE_MAX_FILES = 4_000;

let active = 0;
let writesSincePrune = 0;
const waiting: Array<() => void> = [];

async function takeSlot() {
  if (active < MAX_ACTIVE) {
    active += 1;
    return;
  }
  if (waiting.length >= MAX_WAITING) throw new AppError("Too many thumbnails are being prepared; try again shortly", 503, "THUMBNAILS_BUSY");
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function releaseSlot() {
  active -= 1;
  waiting.shift()?.();
}

function cacheDirectory() {
  return path.join(config.stateDir, "thumbnails");
}

// Keeps the cache bounded by removing the least recently written thumbnails.
async function pruneCache() {
  const directory = cacheDirectory();
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".webp"));
  if (names.length <= CACHE_MAX_FILES) return;
  const entries = await Promise.all(names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries.slice(0, entries.length - Math.floor(CACHE_MAX_FILES * 0.8))) {
    await fs.rm(path.join(directory, entry.name), { force: true });
  }
}

async function storeThumbnail(location: string, data: Buffer) {
  await fs.mkdir(cacheDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${location}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, location);
  writesSincePrune += 1;
  if (writesSincePrune >= 50) {
    writesSincePrune = 0;
    await pruneCache().catch((error) => console.error(error));
  }
}

/**
 * A small WebP preview of an image, cached under a key of the file's identity and modification
 * time so an edited image gets a fresh thumbnail. EXIF orientation is applied and all metadata
 * (location, camera details) is dropped.
 */
export async function thumbnailFor(relativePath: string) {
  const isReserved = await reservedPathCheck();
  const unlock = await acquireFilesystemLock();
  let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
  try {
    opened = await openVerifiedFile(relativePath);
  } finally {
    unlock();
  }
  const { handle, openedPath, stat } = opened;
  try {
    if (!stat.isFile() || isReserved(openedPath)) throw new AppError("Only images have thumbnails", 415, "NO_THUMBNAIL");
    if (!THUMBNAIL_TYPES.has(getMime(openedPath))) throw new AppError("This file type has no thumbnail", 415, "NO_THUMBNAIL");
    if (stat.size > MAX_THUMBNAIL_SOURCE_BYTES) throw new AppError("This image is too large for a thumbnail", 413, "IMAGE_TOO_LARGE");
    const identity = await handle.stat({ bigint: true });
    const key = crypto.createHash("sha256").update(`${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${THUMBNAIL_SIZE}`).digest("hex");
    const cached = path.join(cacheDirectory(), `${key}.webp`);
    const hit = await fs.readFile(cached).catch(() => null);
    if (hit) return hit;

    await takeSlot();
    try {
      const source = await handle.readFile();
      let output: Buffer;
      try {
        output = await sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error", animated: false })
          .rotate()
          .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 72 })
          .toBuffer();
      } catch {
        throw new AppError("This image couldn't be read", 422, "INVALID_IMAGE");
      }
      await storeThumbnail(cached, output);
      return output;
    } finally {
      releaseSlot();
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
