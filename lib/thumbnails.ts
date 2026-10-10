import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "./files";
import { AppError } from "./http";
import { THUMBNAIL_SIZE, imageThumbnailsAvailable, resizeImage } from "./image-resize";
import { videoFrame, videoThumbnailsAvailable } from "./video-frames";

// Images are decoded outside FilesDude (see image-resize.ts), which is CPU- and memory-heavy, so at
// most two images (and one video) are thumbnailed at once.

/**
 * Formats thumbnails are made for. sharp picks a decoder from a file's contents, not its name, so
 * the leading bytes are checked too (and the detected format afterwards, by the decoding process):
 * an SVG, TIFF, or PDF renamed to .png never reaches its decoder.
 */
export const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
export const DECODED_FORMATS = new Set(["jpeg", "png", "gif", "webp", "heif"]);
/** Videos get a thumbnail from one frame, taken in a sandbox (see video-frames.ts), when available. */
export const VIDEO_THUMBNAIL_TYPES = new Set(["video/mp4", "video/webm", "video/x-matroska", "video/quicktime", "video/x-msvideo"]);
export const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_FILES = 4_000;
// Videos for which no frame could be taken (often slowly) aren't tried again for a while.
const FAILED_VIDEOS_MAX = 2_000;
const FAILED_VIDEO_RETRY_MS = 6 * 60 * 60 * 1000;

let writesSincePrune = 0;
const failedVideos = new Map<string, number>();

// A queue allowing a few thumbnails to be made at once. Images and videos have separate queues,
// so slow videos never hold up images.
export function limiter(maxActive: number, maxWaiting: number, busy = "Too many thumbnails are being prepared; try again shortly", code = "THUMBNAILS_BUSY") {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async take() {
      if (active < maxActive) {
        active += 1;
        return;
      }
      if (waiting.length >= maxWaiting) throw new AppError(busy, 503, code);
      // A released slot is handed straight to the next waiter, so nobody arriving meanwhile takes it.
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

/** Image decoding, shared with media details: libuv's small thread pool is shared with file I/O. */
export const imageSlots = limiter(2, 200);
const videoSlots = limiter(1, 50);

function videoFailed(key: string) {
  const failedAt = failedVideos.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_VIDEO_RETRY_MS) return true;
  failedVideos.delete(key);
  return false;
}

function rememberFailedVideo(key: string) {
  failedVideos.delete(key);
  failedVideos.set(key, Date.now());
  // Maps keep insertion order, so the first key is the oldest failure.
  if (failedVideos.size > FAILED_VIDEOS_MAX) failedVideos.delete(failedVideos.keys().next().value!);
}

function cacheDirectory() {
  return path.join(config.stateDir, "thumbnails");
}

export function looksLikeRasterImage(header: Buffer) {
  const ascii = (start: number, end: number) => header.toString("latin1", start, end);
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return true;
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return true;
  if (ascii(4, 8) === "ftyp") {
    // An ISO-BMFF "ftyp" box listing an AVIF brand, as the major brand or a compatible one.
    const boxEnd = Math.min(header.readUInt32BE(0), header.length);
    const brands = [ascii(8, 12)];
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(ascii(offset, offset + 4));
    return brands.includes("avif") || brands.includes("avis");
  }
  return false;
}

// The cache is only used when its folder is a real, private folder owned by this process, so it
// can never be redirected through a symlink if the state directory sits somewhere users can write.
async function usableCacheDirectory() {
  const directory = cacheDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const stat = await fs.lstat(directory).catch(() => null);
  const ownUid = typeof process.getuid === "function" ? process.getuid() : stat?.uid;
  return stat && stat.isDirectory() && stat.uid === ownUid && (stat.mode & 0o077) === 0 ? directory : null;
}

// Keeps the cache bounded by removing the least recently written thumbnails.
async function pruneCache(directory: string) {
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".webp"));
  if (names.length <= CACHE_MAX_FILES) return;
  const entries = await Promise.all(names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries.slice(0, entries.length - Math.floor(CACHE_MAX_FILES * 0.8))) {
    await fs.rm(path.join(directory, entry.name), { force: true });
  }
}

async function storeThumbnail(name: string, data: Buffer) {
  const directory = await usableCacheDirectory();
  if (!directory) return;
  const location = path.join(directory, name);
  const temporary = `${location}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, location);
  writesSincePrune += 1;
  if (writesSincePrune >= 50) {
    writesSincePrune = 0;
    await pruneCache(directory).catch((error) => console.error(error));
  }
}

// A video's thumbnail: one frame (a PNG from the sandbox), checked and resized like an image (and,
// like an image, never decoded here).
async function videoThumbnail(fd: number, key: string) {
  const noFrame = () => new AppError("No frame could be taken from this video", 422, "INVALID_VIDEO");
  if (videoFailed(key)) throw noFrame();
  await videoSlots.take();
  try {
    // It may have failed while this request waited for its turn.
    if (videoFailed(key)) throw noFrame();
    const frame = await videoFrame(fd);
    if (!frame || !frame.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      rememberFailedVideo(key);
      throw noFrame();
    }
    const output = await resizeImage(frame, { formats: ["png"], orient: false, maxBytes: frame.length });
    if (!output) {
      rememberFailedVideo(key);
      throw noFrame();
    }
    await storeThumbnail(`${key}.webp`, output);
    return output;
  } finally {
    videoSlots.release();
  }
}

/**
 * A small WebP preview of an image or video, cached under a key of the file's identity, size, and
 * modification and change times, so an edited image gets a fresh thumbnail (the change time can't
 * be set by users, unlike the modification time). EXIF orientation is applied and all metadata
 * (location, camera details) is dropped. `etag` lets browsers revalidate without a decode.
 */
export async function thumbnailFor(relativePath: string, knownEtag?: string | null): Promise<{ data: Buffer | null; etag: string }> {
  // Refuse other names before opening anything.
  const video = VIDEO_THUMBNAIL_TYPES.has(getMime(relativePath));
  if (!THUMBNAIL_TYPES.has(getMime(relativePath)) && !video) throw new AppError("This file type has no thumbnail", 415, "NO_THUMBNAIL");
  if (video && !(await videoThumbnailsAvailable() && await imageThumbnailsAvailable())) throw new AppError("Video thumbnails aren't available on this server", 415, "NO_THUMBNAIL");
  if (!video && !(await imageThumbnailsAvailable())) throw new AppError("Image thumbnails aren't available on this server", 415, "NO_THUMBNAIL");
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
    if (!stat.isFile() || isReserved(openedPath)) throw new AppError("Only images and videos have thumbnails", 415, "NO_THUMBNAIL");
    if (video ? !VIDEO_THUMBNAIL_TYPES.has(getMime(openedPath)) : !THUMBNAIL_TYPES.has(getMime(openedPath))) throw new AppError("This file type has no thumbnail", 415, "NO_THUMBNAIL");
    const identity = await handle.stat({ bigint: true });
    // A video frame is found by seeking, so a large video is fine; an image is read whole, at most at
    // the size measured here (the one that is read), not the one from opening it.
    if (!video && identity.size > BigInt(MAX_THUMBNAIL_SOURCE_BYTES)) throw new AppError("This image is too large for a thumbnail", 413, "IMAGE_TOO_LARGE");
    const key = crypto.createHash("sha256").update(`${config.root}:${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}:${THUMBNAIL_SIZE}`).digest("hex");
    const etag = `"${key.slice(0, 32)}"`;
    if (knownEtag === etag) return { data: null, etag };
    const hit = await fs.readFile(path.join(cacheDirectory(), `${key}.webp`)).catch(() => null);
    if (hit) return { data: hit, etag };
    if (video) return { data: await videoThumbnail(handle.fd, key), etag };

    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!looksLikeRasterImage(header.subarray(0, bytesRead))) throw new AppError("This image couldn't be read", 422, "INVALID_IMAGE");

    await imageSlots.take();
    try {
      // The decoding process is given the open file itself, never its path.
      const output = await resizeImage(handle.fd, { formats: [...DECODED_FORMATS], orient: true, maxBytes: Number(identity.size) });
      if (!output) throw new AppError("This image couldn't be read", 422, "INVALID_IMAGE");
      await storeThumbnail(`${key}.webp`, output);
      return { data: output, etag };
    } finally {
      imageSlots.release();
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
