import crypto from "node:crypto";
import sharp from "sharp";
import { reservedPathCheck } from "./archives";
import { config } from "./config";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "./files";
import { AppError } from "./http";
import { INPUT_LIMITS, sandboxRunner } from "./media-sandbox";
import { DECODED_FORMATS, MAX_THUMBNAIL_SOURCE_BYTES, THUMBNAIL_TYPES, VIDEO_THUMBNAIL_TYPES, limiter, looksLikeRasterImage, readExactly } from "./thumbnails";

/**
 * Media details for Properties: an image's dimensions, format, frames, and (from EXIF) camera and
 * date taken, read by sharp; a video's or audio file's length, resolution, frame rate, codecs, and
 * tags, read by ffprobe in the same sandbox as video thumbnails (see media-sandbox.ts).
 */
export type MediaInfo = {
  kind: "image" | "video" | "audio";
  format?: string;
  width?: number;
  height?: number;
  frames?: number;
  bitDepth?: string;
  colorSpace?: string;
  hasAlpha?: boolean;
  camera?: string;
  taken?: string;
  duration?: number;
  bitRate?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  title?: string;
  artist?: string;
  album?: string;
};

export type ProbeRunner = (fd: number) => Promise<Buffer | null>;

export const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/aac"]);
const MAX_PROBE_BYTES = 1024 * 1024;
const MAX_SOURCE_PIXELS = 100_000_000;
const CACHE_MAX = 2_000;

// Cached by the file's identity, so an edited file is read again; null means it couldn't be read.
const cache = new Map<string, MediaInfo | null>();
const imageSlots = limiter(2, 100);
const probeSlots = limiter(2, 50);
let runner: ProbeRunner | null | undefined;

/** Replaces how audio and video are read (tests use a fake); null means ffprobe isn't available. */
export function setProbeRunner(replacement: ProbeRunner | null | undefined) {
  runner = replacement;
  cache.clear();
}

async function probeRunner() {
  if (runner === undefined) {
    const run = process.env.FILEDUDE_MEDIA_INFO === "false" ? null : await sandboxRunner(process.env.FILEDUDE_FFPROBE_PATH || "/usr/bin/ffprobe");
    runner = run && ((fd) => run([
      "-v", "error", ...INPUT_LIMITS, "-fd", "0", "-i", "fd:",
      "-show_entries", "format=format_long_name,duration,bit_rate:format_tags=title,artist,album:stream=codec_type,codec_name,profile,width,height,avg_frame_rate,sample_rate,channels,channel_layout:stream_side_data=rotation",
      "-of", "json",
    ], fd, MAX_PROBE_BYTES));
  }
  return runner;
}

/** Whether this server can read audio and video details. */
export async function mediaProbeAvailable() {
  return (await probeRunner()) !== null;
}

function remember(key: string, info: MediaInfo | null) {
  cache.delete(key);
  cache.set(key, info);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

// Text from a file (tags, EXIF): printable characters only, trimmed, and short.
function cleanText(value: unknown, max = 120) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);
  return text || undefined;
}

function positiveNumber(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 && number <= max ? number : undefined;
}

const CODECS: Record<string, string> = {
  h264: "H.264", hevc: "H.265 (HEVC)", av1: "AV1", vp8: "VP8", vp9: "VP9", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", prores: "ProRes", mjpeg: "Motion JPEG",
  aac: "AAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", alac: "ALAC", ac3: "Dolby Digital (AC-3)", eac3: "Dolby Digital Plus", dts: "DTS", truehd: "Dolby TrueHD",
};

function codecName(stream: Record<string, unknown>) {
  const name = cleanText(stream.codec_name, 40);
  if (!name) return undefined;
  const label = CODECS[name] ?? (name.startsWith("pcm_") ? "PCM" : name.toUpperCase());
  const profile = cleanText(stream.profile, 40);
  return profile && profile.toLowerCase() !== name ? `${label} (${profile})` : label;
}

/** The useful parts of ffprobe's JSON, each checked; anything unexpected is left out. */
export function parseProbe(output: Buffer, kind: "video" | "audio"): MediaInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(output.toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { format, streams } = data as { format?: Record<string, unknown>; streams?: unknown };
  const list = (Array.isArray(streams) ? streams : []).filter((stream): stream is Record<string, unknown> => !!stream && typeof stream === "object");
  const video = list.find((stream) => stream.codec_type === "video");
  const audio = list.filter((stream) => stream.codec_type === "audio");
  const subtitles = list.filter((stream) => stream.codec_type === "subtitle");
  if (!video && !audio.length) return null;
  const info: MediaInfo = { kind: video && kind === "video" ? "video" : "audio" };
  const formatInfo = format && typeof format === "object" ? format : {};
  info.format = cleanText(formatInfo.format_long_name, 60);
  info.duration = positiveNumber(formatInfo.duration, 10 * 365 * 24 * 3600);
  info.bitRate = positiveNumber(formatInfo.bit_rate);
  if (video && info.kind === "video") {
    let width = positiveNumber(video.width, 100_000);
    let height = positiveNumber(video.height, 100_000);
    // Phones record portrait video as landscape with a rotation to apply when playing.
    const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
    const rotation = sideData.map((entry) => (entry && typeof entry === "object" ? Number((entry as Record<string, unknown>).rotation) : NaN)).find(Number.isFinite);
    if (rotation !== undefined && Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    Object.assign(info, { width, height, videoCodec: codecName(video) });
    const [numerator, denominator] = typeof video.avg_frame_rate === "string" ? video.avg_frame_rate.split("/").map(Number) : [];
    const rate = numerator / denominator;
    if (Number.isFinite(rate) && rate > 0 && rate <= 1000) info.frameRate = Math.round(rate * 100) / 100;
  }
  if (audio.length) {
    const first = audio[0];
    info.audioCodec = codecName(first);
    info.sampleRate = positiveNumber(first.sample_rate, 10_000_000);
    const channels = positiveNumber(first.channels, 64);
    const layout = cleanText(first.channel_layout, 30);
    info.channels = layout ? layout.replace(/\(.*\)$/, "") : channels ? `${channels} channel${channels === 1 ? "" : "s"}` : undefined;
    if (audio.length > 1) info.audioTracks = audio.length;
  }
  if (subtitles.length) info.subtitleTracks = subtitles.length;
  // Tag names vary in case between formats (title, TITLE).
  const tags = formatInfo.tags && typeof formatInfo.tags === "object" ? Object.fromEntries(Object.entries(formatInfo.tags as Record<string, unknown>).map(([name, value]) => [name.toLowerCase(), value])) : {};
  info.title = cleanText(tags.title);
  info.artist = cleanText(tags.artist);
  info.album = cleanText(tags.album);
  return withoutEmpty(info);
}

function withoutEmpty(info: MediaInfo) {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as MediaInfo;
}

/**
 * Camera and date taken from an image's EXIF block (a TIFF structure, after an "Exif" header in
 * JPEG and WebP). Every offset is bounds-checked; anything malformed just gives no details.
 */
export function parseExif(exif: Buffer | undefined): { camera?: string; taken?: string } {
  if (!exif) return {};
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  if (tiff.length < 8) return {};
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return {};
  const little = order === "II";
  const u16 = (offset: number) => (offset + 2 <= tiff.length ? (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset)) : -1);
  const u32 = (offset: number) => (offset + 4 <= tiff.length ? (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)) : -1);
  if (u16(2) !== 42) return {};
  const readIfd = (offset: number) => {
    const values = new Map<number, { type: number; count: number; at: number }>();
    const count = u16(offset);
    if (count < 0 || count > 512) return values;
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      if (entry + 12 > tiff.length) break;
      const type = u16(entry + 2);
      const items = u32(entry + 4);
      // Values of up to four bytes are stored in the entry itself; longer ones at an offset.
      const size = type === 2 ? items : type === 4 ? items * 4 : 0;
      values.set(u16(entry), { type, count: items, at: size > 4 ? u32(entry + 8) : entry + 8 });
    }
    return values;
  };
  const ascii = (field: { type: number; count: number; at: number } | undefined) => {
    if (!field || field.type !== 2 || field.count > 256 || field.at < 0 || field.at + field.count > tiff.length) return undefined;
    return cleanText(tiff.toString("latin1", field.at, field.at + field.count).replace(/\0[\s\S]*$/, ""), 80);
  };
  const ifd0 = readIfd(u32(4));
  const make = ascii(ifd0.get(0x010f));
  const model = ascii(ifd0.get(0x0110));
  const pointer = ifd0.get(0x8769);
  const exifIfd = pointer && pointer.type === 4 ? readIfd(u32(pointer.at)) : new Map();
  const original = ascii(exifIfd.get(0x9003)) ?? ascii(ifd0.get(0x0132));
  const date = original?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  const camera = make && model && !model.toLowerCase().startsWith(make.toLowerCase().split(" ")[0]) ? `${make} ${model}` : model ?? make;
  const result: { camera?: string; taken?: string } = {};
  if (camera) result.camera = camera;
  if (date && date[1] !== "0000") result.taken = `${date[1]}-${date[2]}-${date[3]} ${date[4]}:${date[5]}:${date[6]}`;
  return result;
}

async function imageInfo(handle: Awaited<ReturnType<typeof openVerifiedFile>>["handle"], size: number): Promise<MediaInfo | null> {
  const header = Buffer.alloc(64);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (!looksLikeRasterImage(header.subarray(0, bytesRead))) return null;
  await imageSlots.take();
  try {
    const source = await readExactly(handle, size);
    const meta = await sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error", animated: true }).metadata();
    if (!meta.format || !DECODED_FORMATS.has(meta.format)) return null;
    // EXIF orientations 5-8 turn the picture on its side.
    const sideways = (meta.orientation ?? 1) >= 5;
    const height = meta.pageHeight ?? meta.height;
    return withoutEmpty({
      kind: "image",
      format: meta.format === "heif" ? "AVIF" : meta.format.toUpperCase(),
      width: sideways ? height : meta.width,
      height: sideways ? meta.width : height,
      frames: meta.pages && meta.pages > 1 ? meta.pages : undefined,
      bitDepth: typeof meta.depth === "string" ? meta.depth.replace(/^u?char$/, "8-bit").replace(/^u?short$/, "16-bit") : undefined,
      colorSpace: meta.space ? meta.space.toUpperCase().replace(/^B-W$/, "Greyscale") : undefined,
      hasAlpha: meta.hasAlpha || undefined,
      ...parseExif(meta.exif),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  } finally {
    imageSlots.release();
  }
}

async function avInfo(fd: number, kind: "video" | "audio") {
  const run = await probeRunner();
  if (!run) return null;
  await probeSlots.take();
  try {
    const output = await run(fd);
    return output ? parseProbe(output, kind) : null;
  } finally {
    probeSlots.release();
  }
}

/** Media details of an image, video, or audio file. */
export async function mediaInfoFor(relativePath: string): Promise<MediaInfo> {
  const kindOf = (mime: string) => (THUMBNAIL_TYPES.has(mime) ? "image" : VIDEO_THUMBNAIL_TYPES.has(mime) ? "video" : AUDIO_TYPES.has(mime) ? "audio" : null);
  // Refuse other names before opening anything.
  const kind = kindOf(getMime(relativePath));
  if (!kind) throw new AppError("This file type has no media details", 415, "NO_MEDIA_INFO");
  if (kind !== "image" && !(await mediaProbeAvailable())) throw new AppError("Audio and video details aren't available on this server", 415, "NO_MEDIA_INFO");
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
    if (!stat.isFile() || isReserved(openedPath) || kindOf(getMime(openedPath)) !== kind) throw new AppError("This file type has no media details", 415, "NO_MEDIA_INFO");
    if (kind === "image" && stat.size > MAX_THUMBNAIL_SOURCE_BYTES) throw new AppError("This image is too large to read its details", 413, "IMAGE_TOO_LARGE");
    const identity = await handle.stat({ bigint: true });
    const key = crypto.createHash("sha256").update(`${config.root}:${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`).digest("hex");
    let info = cache.get(key);
    if (info === undefined) {
      info = kind === "image" ? await imageInfo(handle, Number(identity.size)) : await avInfo(handle.fd, kind);
      remember(key, info);
    }
    if (!info) throw new AppError("This file's media details couldn't be read", 422, "INVALID_MEDIA");
    return info;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
