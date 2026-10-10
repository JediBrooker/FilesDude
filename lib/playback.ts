import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "./files";
import { AppError } from "./http";
import { inputLimits, sandboxFileRunner, sandboxRunner, VIDEO_FORMATS } from "./media-sandbox";

// Copies of videos that play in any browser, including Safari on iPhones, which can't play MKV at
// all, and Chrome, which has no AC-3 or E-AC-3 sound. ffmpeg repackages the video as MP4 without
// re-encoding the picture (so it's quick and loses nothing) and turns the sound into stereo AAC
// where needed. It runs in the media sandbox, reading the opened video and writing straight into a
// file FilesDude opened for it. Copies are kept in the state folder, up to a total size
// (FILEDUDE_PLAYBACK_CACHE_GB, 50 GB by default), the least recently watched going first.

/** Picture formats MP4 can carry as they are; others would need re-encoding, which isn't offered. */
const COPY_VIDEO = new Set(["h264", "hevc"]);
/** Sound formats kept as they are; anything else becomes stereo AAC. */
const KEEP_AUDIO = new Set(["aac", "mp3"]);
const FAILURE_RETRY_MS = 10 * 60_000;
const MAX_WAITING = 4;

export type PlaybackRunners = {
  probe: (fd: number) => Promise<Buffer | null>;
  remux: (args: string[], input: number, output: number, maxBytes: number, seconds: number, signal?: AbortSignal) => Promise<boolean>;
};
let runners: PlaybackRunners | null | undefined;

/** Replaces how videos are probed and repackaged (tests use fakes); null means ffmpeg isn't available. */
export function setPlaybackRunners(replacement: PlaybackRunners | null | undefined) {
  runners = replacement;
  codecCache.clear();
  failures.clear();
}

async function playbackRunners() {
  if (runners === undefined) {
    const probe = await sandboxRunner(process.env.FILEDUDE_FFPROBE_PATH || "/usr/bin/ffprobe");
    const remux = await sandboxFileRunner(process.env.FILEDUDE_FFMPEG_PATH || "/usr/bin/ffmpeg");
    runners = probe && remux && process.env.FILEDUDE_PLAYBACK !== "false" ? {
      probe: (fd) => probe(["-v", "error", ...inputLimits(VIDEO_FORMATS), "-show_entries", "stream=codec_type,codec_name:format=format_name", "-of", "json", "fd:"], fd, 256 * 1024),
      remux,
    } : null;
  }
  return runners;
}

export async function playbackAvailable() {
  return Boolean(await playbackRunners());
}

const cacheDir = () => path.join(config.stateDir, "playback");
const maxCacheBytes = () => {
  const gigabytes = Number(process.env.FILEDUDE_PLAYBACK_CACHE_GB);
  return (Number.isFinite(gigabytes) && gigabytes > 0 ? gigabytes : 50) * 1024 ** 3;
};

type Video = Awaited<ReturnType<typeof openVerifiedFile>> & { key: string; size: number };

async function openVideo(relativePath: string): Promise<Video> {
  if (!getMime(relativePath).startsWith("video/")) throw new AppError("Only videos can be played", 415, "NOT_A_VIDEO");
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
  try {
    opened = await openVerifiedFile(relativePath);
  } finally {
    release();
  }
  if (!opened.stat.isFile() || isReserved(opened.openedPath) || !getMime(opened.openedPath).startsWith("video/")) {
    await opened.handle.close().catch(() => undefined);
    throw new AppError("Only videos can be played", 415, "NOT_A_VIDEO");
  }
  // The copy belongs to this exact video: a changed or different file gets its own.
  const identity = await opened.handle.stat({ bigint: true });
  const key = crypto.createHash("sha256").update(`playback-v1:${config.root}:${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`).digest("hex");
  return { ...opened, key, size: Number(identity.size) };
}

export type Codecs = { container: string; video?: string; audio?: string };
const codecCache = new Map<string, Codecs>();

async function codecsOf(video: Video, run: PlaybackRunners): Promise<Codecs | null> {
  const cached = codecCache.get(video.key);
  if (cached) return cached;
  const output = await run.probe(video.handle.fd);
  if (!output) return null;
  try {
    const data = JSON.parse(output.toString("utf8")) as { streams?: Array<{ codec_type?: unknown; codec_name?: unknown }>; format?: { format_name?: unknown } };
    const name = (value: unknown) => (typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value) ? value : undefined);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const codecs: Codecs = {
      container: typeof data.format?.format_name === "string" && /^[a-z0-9_,]{1,80}$/.test(data.format.format_name) ? data.format.format_name : "unknown",
      video: name(streams.find((stream) => stream?.codec_type === "video")?.codec_name),
      audio: name(streams.find((stream) => stream?.codec_type === "audio")?.codec_name),
    };
    codecCache.set(video.key, codecs);
    if (codecCache.size > 5_000) codecCache.delete(codecCache.keys().next().value!);
    return codecs;
  } catch {
    return null;
  }
}

type Job = { key: string; size: number; written: () => Promise<number>; promise: Promise<void>; account: string };
const jobs = new Map<string, Job>();
const failures = new Map<string, number>();
let running: Promise<void> = Promise.resolve();
let waiting = 0;

export type PlaybackStatus = { state: "ready" | "preparing" | "none" | "unsupported" | "failed" | "unavailable"; progress?: number; codecs?: Codecs };

const readyFile = (key: string) => path.join(cacheDir(), `${key}.mp4`);
const exists = (file: string) => fs.lstat(file).then((stat) => stat.isFile(), () => false);

async function statusOf(video: Video): Promise<PlaybackStatus> {
  const run = await playbackRunners();
  if (!run) return { state: "unavailable" };
  if (await exists(readyFile(video.key))) return { state: "ready", codecs: codecCache.get(video.key) };
  const job = jobs.get(video.key);
  if (job) return { state: "preparing", progress: Math.min(0.99, (await job.written()) / Math.max(1, job.size)), codecs: codecCache.get(video.key) };
  const codecs = await codecsOf(video, run);
  if (!codecs || !codecs.video || !COPY_VIDEO.has(codecs.video)) return { state: "unsupported", codecs: codecs ?? undefined };
  const failedAt = failures.get(video.key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_RETRY_MS) return { state: "failed", codecs };
  return { state: "none", codecs };
}

/** Whether a playable copy of this video exists or is being made, and what's in the video. */
export async function playbackStatus(relativePath: string) {
  const video = await openVideo(relativePath);
  try {
    return await statusOf(video);
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}

/**
 * Starts making a playable copy (one at a time, a few waiting; one per account). Returns the status;
 * the copy is made in the background, so the browser asks again until it's ready.
 */
export async function preparePlayback(relativePath: string, account: string) {
  const video = await openVideo(relativePath);
  let handedOver = false;
  try {
    const status = await statusOf(video);
    if (status.state !== "none") return status;
    if ([...jobs.values()].some((job) => job.account === account)) throw new AppError("Another video is being prepared for you; try again when it's ready", 429, "PLAYBACK_BUSY");
    if (waiting >= MAX_WAITING) throw new AppError("Other videos are being prepared; try again in a few minutes", 503, "PLAYBACK_BUSY");
    const run = (await playbackRunners())!;
    const codecs = status.codecs!;
    await fs.mkdir(cacheDir(), { recursive: true, mode: 0o700 });
    const temporary = path.join(cacheDir(), `${video.key}.${crypto.randomUUID()}.part`);
    const output = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    waiting += 1;
    const job: Job = {
      key: video.key,
      size: video.size,
      account,
      written: () => output.stat().then((stat) => stat.size, () => 0),
      promise: Promise.resolve(),
    };
    const work = async () => {
      waiting -= 1;
      try {
        const args = [
          "-hide_banner", "-loglevel", "error", "-nostdin", ...inputLimits(VIDEO_FORMATS), "-i", "fd:",
          "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", ...(codecs.video === "hevc" ? ["-tag:v", "hvc1"] : []),
          ...(codecs.audio && KEEP_AUDIO.has(codecs.audio) ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]),
          "-sn", "-dn", "-map_chapters", "-1", "-map_metadata", "-1", "-f", "mp4", "-fd", "1", "fd:",
        ];
        // Repackaging reads the whole video; allowed a slow 8 MB/s plus two minutes.
        const ok = await run.remux(args, video.handle.fd, output.fd, video.size * 1.5 + 64 * 1024 * 1024, 120 + video.size / (8 * 1024 * 1024));
        await output.close();
        if (!ok) throw new Error("ffmpeg couldn't repackage the video");
        await fs.rename(temporary, readyFile(video.key));
        await evict(video.key);
      } catch (error) {
        failures.set(video.key, Date.now());
        if (failures.size > 2_000) failures.delete(failures.keys().next().value!);
        console.error("A video couldn't be prepared for playback:", (error as Error).message);
        await output.close().catch(() => undefined);
        await fs.unlink(temporary).catch(() => undefined);
      } finally {
        jobs.delete(video.key);
        await video.handle.close().catch(() => undefined);
      }
    };
    job.promise = running.then(work, work);
    running = job.promise;
    jobs.set(video.key, job);
    handedOver = true;
    return { state: "preparing", progress: 0, codecs } satisfies PlaybackStatus;
  } finally {
    if (!handedOver) await video.handle.close().catch(() => undefined);
  }
}

/** Keeps the copies within their total size, removing the least recently watched first. */
async function evict(keep: string) {
  const names = await fs.readdir(cacheDir()).catch(() => [] as string[]);
  const now = Date.now();
  const copies: Array<{ name: string; size: number; used: number }> = [];
  for (const name of names) {
    const stat = await fs.lstat(path.join(cacheDir(), name)).catch(() => null);
    if (!stat?.isFile()) continue;
    // Pieces left by a restart part-way through are removed after a day.
    if (name.endsWith(".part") && now - stat.mtimeMs > 24 * 3_600_000) await fs.unlink(path.join(cacheDir(), name)).catch(() => undefined);
    else if (name.endsWith(".mp4")) copies.push({ name, size: stat.size, used: stat.mtimeMs });
  }
  let total = copies.reduce((sum, copy) => sum + copy.size, 0);
  for (const copy of copies.sort((a, b) => a.used - b.used)) {
    if (total <= maxCacheBytes()) break;
    if (copy.name === `${keep}.mp4`) continue;
    await fs.unlink(path.join(cacheDir(), copy.name)).catch(() => undefined);
    total -= copy.size;
  }
}

/** Opens the playable copy of this video for streaming (and marks it as just watched), or refuses. */
export async function openPlayback(relativePath: string) {
  const video = await openVideo(relativePath);
  try {
    const file = readyFile(video.key);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) throw new AppError("This video hasn't been prepared for playback", 404, "NOT_PREPARED");
    const stat = await handle.stat();
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => undefined);
    return { handle, size: stat.size };
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}

/** For tests: waits for every preparation to finish. */
export async function waitForPlaybackJobs() {
  await running.catch(() => undefined);
}
