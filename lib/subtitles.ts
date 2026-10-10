import crypto from "node:crypto";
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
 * once, one at a time, and kept in the state directory.
 */
export type SubtitleTrack = { id: string; label: string; language?: string; source: "file" | "embedded" };
export type SubtitleRunners = { probe: (fd: number) => Promise<Buffer | null>; extract: (fd: number, stream: number) => Promise<Buffer | null> };

const SIDECAR = /\.(srt|vtt)$/i;
// Text formats ffmpeg can turn into WebVTT; picture-based ones (PGS, VobSub) can't be.
const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const EXTRACT_SECONDS = 600;
const LANGUAGES: Record<string, string> = { en: "English", eng: "English", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German", es: "Spanish", spa: "Spanish", it: "Italian", ita: "Italian", ja: "Japanese", jpn: "Japanese", zh: "Chinese", chi: "Chinese", zho: "Chinese", ko: "Korean", kor: "Korean", pt: "Portuguese", por: "Portuguese", nl: "Dutch", dut: "Dutch", nld: "Dutch", sv: "Swedish", swe: "Swedish", no: "Norwegian", nor: "Norwegian", da: "Danish", dan: "Danish", fi: "Finnish", fin: "Finnish", ru: "Russian", rus: "Russian", pl: "Polish", pol: "Polish" };

const slots = limiter(1, 20, "Other subtitles are being prepared; try again shortly", "SUBTITLES_BUSY");
let runners: SubtitleRunners | null | undefined;

/** Replaces how embedded subtitles are read (tests use fakes); null means ffmpeg isn't available. */
export function setSubtitleRunners(replacement: SubtitleRunners | null | undefined) {
  runners = replacement;
}

async function subtitleRunners() {
  if (runners === undefined) {
    const probe = await sandboxRunner(process.env.FILEDUDE_FFPROBE_PATH || "/usr/bin/ffprobe");
    const extract = await sandboxRunner(process.env.FILEDUDE_FFMPEG_PATH || "/usr/bin/ffmpeg");
    runners = probe && extract ? {
      probe: (fd) => probe(["-v", "error", ...inputLimits(VIDEO_FORMATS), "-fd", "0", "-i", "fd:", "-select_streams", "s", "-show_entries", "stream=index,codec_name:stream_tags=language,title", "-of", "json"], fd, 1024 * 1024),
      extract: (fd, stream) => extract(["-nostdin", "-hide_banner", "-loglevel", "error", ...inputLimits(VIDEO_FORMATS), "-fd", "0", "-i", "fd:", "-map", `0:${stream}`, "-f", "webvtt", "pipe:1"], fd, MAX_SUBTITLE_BYTES, EXTRACT_SECONDS),
    } : null;
  }
  return runners;
}

const languageName = (code: string | undefined) => (code ? LANGUAGES[code.toLowerCase()] ?? code : undefined);
const clean = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || undefined : undefined);

/** Text of a subtitle file: UTF-8, or Windows-1252 for older files that aren't. */
function decode(data: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** SRT as WebVTT: the same cues with a header and dots in the times. */
export function srtToVtt(text: string) {
  const body = text.replace(/\r\n?/g, "\n").replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").trim();
  return `WEBVTT\n\n${body}\n`;
}

function asVtt(text: string, srt: boolean) {
  if (srt) return srtToVtt(text);
  return /^WEBVTT/.test(text) ? text : `WEBVTT\n\n${text}`;
}

const isVideo = (name: string) => getMime(name).startsWith("video/");

// The video, opened and checked, with its folder and a key for caching what's made from it.
async function openVideo(relativePath: string) {
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

/** Subtitle files beside the video: its name, then optionally a language or label, then .srt or .vtt. */
async function sidecars(relativePath: string) {
  const stem = stemOf(relativePath.split("/").at(-1) ?? "");
  const release = await acquireFilesystemLock();
  let folder: Awaited<ReturnType<typeof openDirectory>>;
  try {
    folder = await openDirectory(parentOf(relativePath));
  } finally {
    release();
  }
  try {
    const names = await fs.readdir(folder.base);
    return names.filter((name) => SIDECAR.test(name) && (stemOf(name) === stem || name.startsWith(`${stem}.`))).sort().slice(0, 50).map((name): SubtitleTrack => {
      const middle = name.slice(stem.length, name.length - path.extname(name).length).replace(/^\./, "");
      const [code, ...rest] = middle.split(".");
      const language = code && (LANGUAGES[code.toLowerCase()] || /^[a-z]{2,3}$/i.test(code)) ? code.toLowerCase() : undefined;
      const label = [languageName(language) ?? clean(code), ...rest.map((part) => clean(part))].filter(Boolean).join(" · ") || "Subtitles";
      return { id: `file:${name}`, label, language, source: "file" };
    });
  } finally {
    await folder.handle.close().catch(() => undefined);
  }
}

const listCache = new Map<string, SubtitleTrack[]>();

/** The subtitles a video has, beside it and inside it. */
export async function listSubtitles(relativePath: string) {
  const video = await openVideo(relativePath);
  try {
    const files = await sidecars(relativePath);
    let embedded = listCache.get(video.key);
    if (!embedded) {
      embedded = [];
      const run = await subtitleRunners();
      const output = run ? await run.probe(video.handle.fd) : null;
      if (output) {
        try {
          const streams = (JSON.parse(output.toString("utf8")) as { streams?: Array<{ index?: unknown; codec_name?: unknown; tags?: Record<string, unknown> }> }).streams ?? [];
          let number = 0;
          for (const stream of streams.slice(0, 50)) {
            if (typeof stream.index !== "number" || !TEXT_CODECS.has(String(stream.codec_name))) continue;
            number += 1;
            const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
            const language = clean(tags.language)?.toLowerCase();
            const label = clean(tags.title) ?? languageName(language) ?? `Track ${number}`;
            embedded.push({ id: `stream:${stream.index}`, label, language: language && language !== "und" ? language : undefined, source: "embedded" });
          }
        } catch {
          // Unreadable probe output just means no embedded subtitles.
        }
      }
      listCache.set(video.key, embedded);
      if (listCache.size > 500) listCache.delete(listCache.keys().next().value!);
    }
    return [...files, ...embedded];
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}

/** One subtitle track as WebVTT text. */
export async function subtitleTrack(relativePath: string, id: string) {
  if (typeof id !== "string" || id.length > 300) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
  if (id.startsWith("file:")) {
    const name = id.slice(5);
    // Only a subtitle file listed for this video, in its folder.
    if (!(await sidecars(relativePath)).some((track) => track.id === id)) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    const release = await acquireFilesystemLock();
    let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
    try {
      opened = await openVerifiedFile([parentOf(relativePath), name].filter(Boolean).join("/"));
    } finally {
      release();
    }
    try {
      if (!opened.stat.isFile() || opened.stat.size > MAX_SUBTITLE_BYTES) throw new AppError("That subtitle file can't be shown", 415, "UNSUPPORTED_SUBTITLES");
      const data = Buffer.alloc(opened.stat.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await opened.handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return asVtt(decode(data.subarray(0, offset)), /\.srt$/i.test(name));
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
  const match = /^stream:(\d{1,4})$/.exec(id);
  if (!match) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
  const stream = Number(match[1]);
  const video = await openVideo(relativePath);
  try {
    const cacheFolder = path.join(config.stateDir, "subtitles");
    const cached = path.join(cacheFolder, `${video.key}-${stream}.vtt`);
    const hit = await fs.readFile(cached, "utf8").catch(() => null);
    if (hit !== null) return hit;
    if (!(await listSubtitles(relativePath)).some((track) => track.id === id)) throw new AppError("Unknown subtitle track", 404, "NOT_FOUND");
    const run = await subtitleRunners();
    if (!run) throw new AppError("Subtitles inside videos aren't available on this server", 415, "NO_SUBTITLES");
    await slots.take();
    try {
      const output = await run.extract(video.handle.fd, stream);
      if (!output) throw new AppError("Those subtitles couldn't be read from the video", 422, "INVALID_SUBTITLES");
      const text = asVtt(decode(output), false);
      await fs.mkdir(cacheFolder, { recursive: true, mode: 0o700 });
      const temporary = `${cached}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, cached);
      return text;
    } finally {
      slots.release();
    }
  } finally {
    await video.handle.close().catch(() => undefined);
  }
}
