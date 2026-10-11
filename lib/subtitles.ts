import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { acquireFilesystemLock, getMime, openDirectory, openVerifiedFile } from "./files";
import { AppError } from "./http";
import { inputLimits, sandboxRunner, VIDEO_FORMATS } from "./media-sandbox";
import { limiter } from "./thumbnails";

/**
 * Subtitles for a video's preview, as WebVTT (the only format browsers show): subtitle files next to
 * it ("Movie.srt", "Movie.en.vtt"), converted from SRT when needed, and text subtitle tracks inside
 * it, extracted by ffmpeg in the media sandbox. Extracting reads the whole video, so a track is made
 * once (requests for it share that run), one at a time, at most one queued per account, stopped
 * when nobody is waiting any more, and kept in a size-limited cache; one that fails isn't tried
 * again for a while.
 */
export type SubtitleTrack = { id: string; label: string; language?: string; source: "file" | "embedded" };
export type SubtitleRunners = {
  probe: (fd: number) => Promise<Buffer | null>;
  extract: (fd: number, stream: number, signal: AbortSignal) => Promise<Buffer | null>;
};

const SIDECAR = /\.(srt|vtt)$/i;
// Text formats ffmpeg can turn into WebVTT; picture-based ones (PGS, VobSub) can't be.
const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const EXTRACT_SECONDS = 300;
const FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_FILES = 500;
const CACHE_MAX_BYTES = 500 * 1024 * 1024;
const LANGUAGES: Record<string, string> = { en: "English", eng: "English", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German", es: "Spanish", spa: "Spanish", it: "Italian", ita: "Italian", ja: "Japanese", jpn: "Japanese", zh: "Chinese", chi: "Chinese", zho: "Chinese", ko: "Korean", kor: "Korean", pt: "Portuguese", por: "Portuguese", nl: "Dutch", dut: "Dutch", nld: "Dutch", sv: "Swedish", swe: "Swedish", no: "Norwegian", nor: "Norwegian", da: "Danish", dan: "Danish", fi: "Finnish", fin: "Finnish", ru: "Russian", rus: "Russian", pl: "Polish", pol: "Polish" };

const probeSlots = limiter(2, 50, "Other videos are being read; try again shortly", "SUBTITLES_BUSY");
const extractSlots = limiter(1, 20, "Other subtitles are being prepared; try again shortly", "SUBTITLES_BUSY");
const readSlots = limiter(4, 50, "Other subtitles are being read; try again shortly", "SUBTITLES_BUSY");
let runners: SubtitleRunners | null | undefined;

/** Replaces how embedded subtitles are read (tests use fakes); null means ffmpeg isn't available. */
export function setSubtitleRunners(replacement: SubtitleRunners | null | undefined) {
  runners = replacement;
  listCache.clear();
  failures.clear();
}

async function subtitleRunners() {
  if (runners === undefined) {
    const probe = await sandboxRunner("ffprobe");
    const extract = await sandboxRunner("ffmpeg");
    runners = probe && extract ? {
      probe: (fd) => probe(["-v", "error", ...inputLimits(VIDEO_FORMATS), "-fd", "0", "-i", "fd:", "-select_streams", "s", "-show_entries", "stream=index,codec_name:stream_tags=language,title", "-of", "json"], fd, 1024 * 1024),
      extract: (fd, stream, signal) => extract(["-nostdin", "-hide_banner", "-loglevel", "error", ...inputLimits(VIDEO_FORMATS), "-fd", "0", "-i", "fd:", "-map", `0:${stream}`, "-f", "webvtt", "pipe:1"], fd, MAX_SUBTITLE_BYTES, EXTRACT_SECONDS, signal),
    } : null;
  }
  return runners;
}

const languageName = (code: string | undefined) => (code ? LANGUAGES[code.toLowerCase()] ?? code : undefined);
const clean = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || undefined : undefined);

/** Text of a subtitle file: UTF-8, or Windows-1252 for older files that aren't. */
function decode(data: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\ufeff/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** SRT as WebVTT: the same cues with a header and dots in the times. */
export function srtToVtt(text: string) {
  const body = text.replace(/\r\n?/g, "\n").replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").trim();
  return `WEBVTT\n\n${body}\n`;
}

/** WebVTT without STYLE or REGION blocks, which could make the browser fetch from elsewhere. */
export function plainVtt(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/).filter((block) => !/^(STYLE|REGION)\b/.test(block.trimStart()));
  const result = blocks.join("\n\n");
  return /^WEBVTT/.test(result) ? `${result.trimEnd()}\n` : `WEBVTT\n\n${result.trim()}\n`;
}

const isVideo = (name: string) => getMime(name).startsWith("video/");

type Video = Awaited<ReturnType<typeof openVerifiedFile>> & { key: string };

// The video, opened and checked, with a key (from its identity) for caching what's made from it.
async function openVideo(relativePath: string): Promise<Video> {
  if (!isVideo(relativePath)) throw new AppError("Only videos have subtitles", 415, "NOT_A_VIDEO");
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
  try {
    opened = await openVerifiedFile(relativePath);
  } finally {
    release();
  }
  if (!opened.stat.isFile() || isReserved(opened.openedPath) || !isVideo(opened.openedPath)) {
    await opened.handle.close().catch(() => undefined);
    throw new AppError("Only videos have subtitles", 415, "NOT_A_VIDEO");
  }
  const identity = await opened.handle.stat({ bigint: true });
  const key = crypto.createHash("sha256").update(`${config.root}:${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`).digest("hex");
  return { ...opened, key };
}

const parentOf = (relative: string) => relative.split("/").slice(0, -1).join("/");
const stemOf = (name: string) => name.slice(0, name.length - path.extname(name).length);

/**
 * Subtitle files beside the video (its name, then optionally a language or label, then .srt or
 * .vtt), and, when `read` names one, its text: read through the folder's open handle, never through
 * a link, and never one of FilesDude's own files.
 */
async function sidecars(relativePath: string, read?: string) {
  const stem = stemOf(relativePath.split("/").at(-1) ?? "");
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  let folder: Awaited<ReturnType<typeof openDirectory>>;
  try {
    folder = await openDirectory(parentOf(relativePath));
  } finally {
    release();
  }
  try {
    const entries = await fs.readdir(folder.base, { withFileTypes: true });
    const tracks = entries
      .filter((entry) => entry.isFile() && SIDECAR.test(entry.name) && !entry.name.includes("\\") && (stemOf(entry.name) === stem || entry.name.startsWith(`${stem}.`)))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 50)
      .map((name): SubtitleTrack => {
        const middle = name.slice(stem.length, name.length - path.extname(name).length).replace(/^\./, "");
        const [code, ...rest] = middle.split(".");
        const language = code && (LANGUAGES[code.toLowerCase()] || /^[a-z]{2,3}$/i.test(code)) ? code.toLowerCase() : undefined;
        const label = [languageName(language) ?? clean(code), ...rest.map((part) => clean(part))].filter(Boolean).join(" · ") || "Subtitles";
        return { id: `file:${name}`, label, language, source: "file" };
      });
    if (read === undefined) return { tracks };
    const name = read.slice(5);
    if (!tracks.some((track) => track.id === read)) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    const handle = await fs.open(path.join(folder.base, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY).catch(() => null);
    if (!handle) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || isReserved(path.join(folder.real, name)) || stat.size > MAX_SUBTITLE_BYTES) throw new AppError("That subtitle file can't be shown", 415, "UNSUPPORTED_SUBTITLES");
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = decode(data.subarray(0, offset));
      return { tracks, text: /\.srt$/i.test(name) ? srtToVtt(text) : plainVtt(text) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } finally {
    await folder.handle.close().catch(() => undefined);
  }
}

// Embedded subtitle tracks by video key. A probe that failed isn't remembered, so it's tried again.
const listCache = new Map<string, SubtitleTrack[]>();

/** The text subtitle tracks inside an opened video. */
async function embedded(video: Video) {
  const cached = listCache.get(video.key);
  if (cached) return cached;
  const run = await subtitleRunners();
  if (!run) return [];
  await probeSlots.take();
  let output: Buffer | null;
  try {
    // It may have been probed while this request waited.
    const ready = listCache.get(video.key);
    if (ready) return ready;
    output = await run.probe(video.handle.fd);
  } finally {
    probeSlots.release();
  }
  if (!output) return [];
  const tracks: SubtitleTrack[] = [];
  try {
    const streams = (JSON.parse(output.toString("utf8")) as { streams?: Array<{ index?: unknown; codec_name?: unknown; tags?: Record<string, unknown> }> }).streams ?? [];
    let number = 0;
    for (const stream of streams.slice(0, 50)) {
      if (typeof stream.index !== "number" || !TEXT_CODECS.has(String(stream.codec_name))) continue;
      number += 1;
      const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      const language = clean(tags.language)?.toLowerCase();
      const label = clean(tags.title) ?? languageName(language) ?? `Track ${number}`;
      tracks.push({ id: `stream:${stream.index}`, label, language: language && language !== "und" ? language : undefined, source: "embedded" });
    }
  } catch {
    return [];
  }
  listCache.set(video.key, tracks);
  if (listCache.size > 2_000) listCache.delete(listCache.keys().next().value!);
  return tracks;
}

/** The subtitles a video has, beside it and inside it. */
export async function listSubtitles(relativePath: string) {
  const video = await openVideo(relativePath);
  try {
    const { tracks } = await sidecars(relativePath);
    return [...tracks, ...(await embedded(video))];
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}

const cacheFolder = () => path.join(config.stateDir, "subtitles");

// Keeps the cache within its file count and total size by removing the least recently written.
async function pruneCache() {
  const folder = cacheFolder();
  const names = (await fs.readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".vtt"));
  const files = await Promise.all(names.map(async (name) => ({ name, stat: await fs.stat(path.join(folder, name)).catch(() => null) })));
  const present = files.filter((file): file is { name: string; stat: NonNullable<typeof file.stat> } => Boolean(file.stat)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let total = 0;
  for (const [index, file] of present.entries()) {
    total += file.stat.size;
    if (index >= CACHE_MAX_FILES || total > CACHE_MAX_BYTES) await fs.rm(path.join(folder, file.name), { force: true });
  }
}

// Extractions in progress (shared by everyone asking for the same track), recent failures, and
// which account each queued or running extraction belongs to.
const extracting = new Map<string, { promise: Promise<string>; waiters: number; controller: AbortController }>();
const failures = new Map<string, number>();
const activeAccounts = new Map<string, string>();

async function extractTrack(video: Video, stream: number, cached: string, account: string) {
  const run = await subtitleRunners();
  if (!run) throw new AppError("Subtitles inside videos aren't available on this server", 415, "NO_SUBTITLES");
  const name = `${video.key}-${stream}`;
  const failedAt = failures.get(name);
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_RETRY_MS) throw new AppError("Those subtitles couldn't be read from the video", 422, "INVALID_SUBTITLES");
  let job = extracting.get(name);
  if (!job) {
    if ([...activeAccounts.values()].includes(account)) throw new AppError("Your other subtitles are still being prepared; try again when they're ready", 503, "SUBTITLES_BUSY");
    const controller = new AbortController();
    activeAccounts.set(name, account);
    const promise = (async () => {
      await extractSlots.take();
      try {
        // Made while this one waited?
        const ready = await fs.readFile(cached, "utf8").catch(() => null);
        if (ready !== null) return ready;
        const output = await run.extract(video.handle.fd, stream, controller.signal);
        if (controller.signal.aborted) throw new AppError("Preparing the subtitles was cancelled", 499, "CANCELLED");
        if (!output) {
          failures.set(name, Date.now());
          if (failures.size > 2_000) failures.delete(failures.keys().next().value!);
          throw new AppError("Those subtitles couldn't be read from the video", 422, "INVALID_SUBTITLES");
        }
        const text = plainVtt(decode(output));
        await fs.mkdir(cacheFolder(), { recursive: true, mode: 0o700 });
        const temporary = `${cached}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
          await fs.rename(temporary, cached);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
        await pruneCache().catch(() => undefined);
        return text;
      } finally {
        extractSlots.release();
      }
    })();
    job = { promise, waiters: 0, controller };
    extracting.set(name, job);
    promise.finally(() => {
      extracting.delete(name);
      activeAccounts.delete(name);
    }).catch(() => undefined);
  }
  return job;
}

/** One subtitle track of a video as WebVTT text. `signal` ends this request's interest in it. */
export async function subtitleTrack(relativePath: string, id: string, account = "local", signal?: AbortSignal) {
  if (typeof id !== "string" || id.length > 300) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
  const video = await openVideo(relativePath);
  try {
    if (id.startsWith("file:")) {
      await readSlots.take();
      try {
        return (await sidecars(relativePath, id)).text!;
      } finally {
        readSlots.release();
      }
    }
    const match = /^stream:(\d{1,4})$/.exec(id);
    if (!match) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    const stream = Number(match[1]);
    const cached = path.join(cacheFolder(), `${video.key}-${stream}.vtt`);
    const hit = await fs.readFile(cached, "utf8").catch(() => null);
    if (hit !== null) return hit;
    // Checked against the same opened video the track will be extracted from.
    if (!(await embedded(video)).some((track) => track.id === id)) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    const job = await extractTrack(video, stream, cached, account);
    job.waiters += 1;
    // When everyone waiting has gone, the extraction stops.
    const leave = () => {
      job.waiters -= 1;
      if (job.waiters <= 0) job.controller.abort();
    };
    signal?.addEventListener("abort", leave, { once: true });
    try {
      return await job.promise;
    } finally {
      if (!signal?.aborted) job.waiters -= 1;
      signal?.removeEventListener("abort", leave);
    }
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}
