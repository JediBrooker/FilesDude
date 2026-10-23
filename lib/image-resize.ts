import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MOUNT_DIR, runProgram, sandboxAvailable, sandboxRunner } from "./media-sandbox";
import { privileged } from "./privileges";

// Makes thumbnails from images, and reads their details (dimensions, format, EXIF) for Properties.
// sharp (libvips and the decoders under it) parses files that other people control, anyone with an
// upload link included, so it never reads them inside FilesDude: a separate Node.js process does,
// given the already-verified open file (or a video frame's bytes) as standard input, never a path,
// and returning the thumbnail, or the details as JSON, on standard output. Wherever the media
// sandbox is available, that process runs in the same throwaway sandbox as ffmpeg (see
// media-sandbox.ts), with Node.js and its packages shown to it read-only. Without it, a FilesDude
// with privileges (root, or the file capabilities a production install has) gives images no
// thumbnails, and so does the Docker image (FILEDUDE_UNSANDBOXED_IMAGES=false); otherwise (a
// development machine) the process runs as this account with this account's access, which only keeps
// a crash or runaway decode from taking FilesDude down. Either way only the decoders for the allowed formats can run at all.

export interface ResizeJob {
  /** The formats sharp may find in the input, from its contents (whatever the file is called). */
  formats: string[];
  /** Whether to turn the picture upright, following its EXIF orientation. */
  orient: boolean;
  /** The most bytes read from the input; more, and it is refused. */
  maxBytes: number;
}

/** Makes a thumbnail from an open file or bytes, or returns null. */
export type ImageResizer = (input: number | Buffer, job: ResizeJob) => Promise<Buffer | null>;

export interface MetadataJob {
  /** The formats sharp may find in the input, from its contents (whatever the file is called). */
  formats: string[];
  /** The most bytes read from the input; more, and it is refused. */
  maxBytes: number;
}

/**
 * Reads an image's details from an open file or bytes, as JSON: its format, width, height,
 * pageHeight, pages, depth, space, hasAlpha, orientation, and EXIF block (base64); null if the image
 * can't be read; or "changed" if it has more bytes than expected. Nothing (null) means the run failed.
 */
export type ImageMetadataReader = (input: number | Buffer, job: MetadataJob) => Promise<Buffer | null>;

export const THUMBNAIL_SIZE = 320;
export const MAX_SOURCE_PIXELS = 100_000_000;
/** A larger EXIF block is left out of an image's details. */
export const MAX_EXIF_BYTES = 64 * 1024;
const DECODE_TIMEOUT_SECONDS = 10;
// Starting Node.js and sharp, on top of the decode itself.
const RUN_SECONDS = DECODE_TIMEOUT_SECONDS + 5;
const QUALITY = 72;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// The details, with the largest EXIF block, as JSON.
const MAX_METADATA_BYTES = 128 * 1024;
// A decoder that couldn't be started is tried again after a while.
const RETRY_MS = 10 * 60 * 1000;
// A 1×1 PNG, to check that a decoder works before relying on it.
const SAMPLE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQI12P4//8/AAX+Av7czFnnAAAAAElFTkSuQmCC", "base64");

// The decoding process, run as `node -e`. It reads at most maxBytes from standard input, turns off
// every decoder but those for the formats it was asked for (so nothing else ever parses the file),
// accepts AVIF but no other HEIF, and nothing over maxPixels (all frames together, for details),
// and writes the WebP, or the details' JSON, with plain writes (asking Node.js for process.stdout
// would probe the socket it is, which the sandbox's system-call filter forbids).
const WORKER = String.raw`
"use strict";
const fs = require("fs");
const job = JSON.parse(process.argv[1]);
const metadata = job.mode === "metadata";
const write = (output) => {
  for (let offset = 0; offset < output.length; ) offset += fs.writeSync(1, output, offset);
};
// Details always answer in JSON (null for an image that can't be read), so a run that fails (is
// stopped, or never starts) can be told apart from a file that will never be read.
const answer = (value, code) => {
  if (metadata) write(Buffer.from(JSON.stringify(value)));
  process.exit(metadata ? 0 : code);
};
const chunks = [];
let size = 0;
const buffer = Buffer.alloc(1 << 20);
for (;;) {
  const read = fs.readSync(0, buffer, 0, buffer.length, null);
  if (!read) break;
  size += read;
  if (size > job.maxBytes) answer("changed", 3);
  chunks.push(Buffer.from(buffer.subarray(0, read)));
}
const input = Buffer.concat(chunks);
const sharp = require(job.sharp);
sharp.cache(false);
sharp.concurrency(1);
const loaders = { jpeg: "VipsForeignLoadJpeg", png: "VipsForeignLoadPng", gif: "VipsForeignLoadNsgif", webp: "VipsForeignLoadWebp", heif: "VipsForeignLoadHeif" };
sharp.block({ operation: ["VipsForeignLoad"] });
const allowed = job.formats.filter((format) => Object.hasOwn(loaders, format));
if (!allowed.length) answer(null, 2);
sharp.unblock({ operation: allowed.map((format) => loaders[format]) });
const options = { limitInputPixels: job.maxPixels, failOn: "error", animated: metadata };
(async () => {
  const meta = await sharp(input, options).metadata();
  const { format, compression, width, height } = meta;
  if (!format || !allowed.includes(format) || (format === "heif" && compression !== "av1")) answer(null, 2);
  if (!(width > 0 && height > 0 && width * height <= job.maxPixels)) answer(null, 2);
  if (metadata) {
    const exif = meta.exif && meta.exif.length <= job.maxExif ? meta.exif.toString("base64") : undefined;
    const { pageHeight, pages, depth, space, hasAlpha, orientation } = meta;
    answer({ format, width, height, pageHeight, pages, depth, space, hasAlpha, orientation, exif }, 0);
  }
  let image = sharp(input, options).timeout({ seconds: job.seconds });
  if (job.orient) image = image.rotate();
  const output = await image
    .resize(job.size, job.size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: job.quality })
    .toBuffer();
  write(output);
  process.exit(0);
})().catch(() => answer(null, 1));
`;

type WorkerJob = (ResizeJob & { mode: "resize" }) | (MetadataJob & { mode: "metadata" });

/** Runs the decoding process on an open file or bytes, returning at most maxOutput bytes, or null. */
type Worker = (input: number | Buffer, job: WorkerJob, maxOutput: number) => Promise<Buffer | null>;

function workerArguments(sharpPath: string, job: WorkerJob) {
  const settings = { ...job, sharp: sharpPath, maxPixels: MAX_SOURCE_PIXELS, size: THUMBNAIL_SIZE, quality: QUALITY, seconds: DECODE_TIMEOUT_SECONDS, maxExif: MAX_EXIF_BYTES };
  return ["--input-type=commonjs", "-e", WORKER, JSON.stringify(settings)];
}

/** Whether these bytes are a WebP file, as every thumbnail must be. */
export function isWebp(data: Buffer | null): data is Buffer {
  return !!data && data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP";
}

/**
 * How images are decoded: in the sandbox wherever there is one; never in a process of FilesDude's
 * own if it has privileges (root, or capabilities its children would inherit) or that isn't allowed
 * (FILEDUDE_UNSANDBOXED_IMAGES=false, as in the Docker image); and otherwise in a process running as
 * FilesDude's ordinary account.
 */
export function decodingMode({ sandbox, privileged, unsandboxedAllowed = true }: { sandbox: boolean; privileged: boolean; unsandboxedAllowed?: boolean }) {
  return sandbox ? "sandbox" : privileged || !unsandboxedAllowed ? "off" : "process";
}

/** Node.js and sharp (with the packages it needs), which the sandbox helper shows to the sandbox. */
async function sandboxedWorker(): Promise<Worker | null> {
  const run = await sandboxRunner("node", { inspectSockets: true });
  if (!run) return null;
  return (input, job, maxOutput) => run(workerArguments(`${MOUNT_DIR}/node_modules/sharp`, job), input, maxOutput, RUN_SECONDS);
}

function processWorker(modules: string): Worker {
  // No environment is passed on, though the process could still read anything this account can.
  return (input, job, maxOutput) => runProgram(process.execPath, workerArguments(path.join(modules, "sharp"), job), input, maxOutput, RUN_SECONDS * 1000, { env: {} });
}

// Whether the decoding process makes a thumbnail of the sample, and reads its details.
async function works(candidate: Worker) {
  const sample = { formats: ["png"], maxBytes: SAMPLE.length };
  if (!isWebp(await candidate(SAMPLE, { ...sample, mode: "resize", orient: false }, MAX_OUTPUT_BYTES))) return false;
  const details = await candidate(SAMPLE, { ...sample, mode: "metadata" }, MAX_METADATA_BYTES);
  try {
    return JSON.parse(details?.toString() ?? "null")?.width === 1;
  } catch {
    return false;
  }
}

async function workingWorker(): Promise<Worker | null> {
  const withPrivileges = privileged();
  const mode = decodingMode({ sandbox: await sandboxAvailable(), privileged: withPrivileges, unsandboxedAllowed: process.env.FILEDUDE_UNSANDBOXED_IMAGES !== "false" });
  // The packages FilesDude itself runs with (a release's own, in production).
  const modules = path.join(process.cwd(), "node_modules");
  const found = existsSync(path.join(modules, "sharp", "package.json")) ? await fs.realpath(modules) : null;
  const candidate = mode === "sandbox" ? await sandboxedWorker() : mode === "process" && found ? processWorker(found) : null;
  // A sandbox that can't read Node.js or sharp, for example, fails this.
  if (candidate && (await works(candidate))) return candidate;
  console.error(mode === "sandbox"
    ? "Image thumbnails and details are off: the media sandbox couldn't run Node.js and sharp (they and node_modules must be readable by other users)"
    : mode === "off" && withPrivileges
      ? "Image thumbnails and details are off: FilesDude has privileges, so it only reads images in the media sandbox, and its helper (filesdude-sandbox.socket) isn't running"
      : mode === "off"
        ? "Image thumbnails and details are off: the media sandbox isn't running, and FILEDUDE_UNSANDBOXED_IMAGES=false keeps images from being decoded outside it"
        : "Image thumbnails and details are off: sharp couldn't be run");
  return null;
}

let worker: Worker | null | undefined;
let retryAt = Infinity;
let choosing: Promise<Worker | null> | null = null;
// Set by tests in place of the decoding process; undefined means it is used.
let resizer: ImageResizer | null | undefined;
let metadataReader: ImageMetadataReader | null | undefined;

/** Replaces how images are decoded (tests use a fake); null means image thumbnails are off. */
export function setImageResizer(replacement: ImageResizer | null | undefined) {
  resizer = replacement;
}

/** Replaces how image details are read (tests use a fake); null means they can't be read. */
export function setImageMetadataReader(replacement: ImageMetadataReader | null | undefined) {
  metadataReader = replacement;
}

async function currentWorker() {
  if (worker !== undefined && !(worker === null && Date.now() >= retryAt)) return worker;
  choosing ??= workingWorker().catch(() => null).then((chosen) => {
    worker = chosen;
    retryAt = chosen ? Infinity : Date.now() + RETRY_MS;
    choosing = null;
    return chosen;
  });
  return choosing;
}

async function currentResizer(): Promise<ImageResizer | null> {
  if (resizer !== undefined) return resizer;
  const run = await currentWorker();
  return run && ((input, job) => run(input, { ...job, mode: "resize" }, MAX_OUTPUT_BYTES));
}

async function currentMetadataReader(): Promise<ImageMetadataReader | null> {
  if (metadataReader !== undefined) return metadataReader;
  const run = await currentWorker();
  return run && ((input, job) => run(input, { ...job, mode: "metadata" }, MAX_METADATA_BYTES));
}

/** Whether this server can make image thumbnails (videos' too need it, for their frames). */
export async function imageThumbnailsAvailable() {
  return (await currentResizer()) !== null;
}

/** A WebP thumbnail of the image in this open file or these bytes, or null if none can be made. */
export async function resizeImage(input: number | Buffer, job: ResizeJob) {
  const run = await currentResizer();
  if (!run) return null;
  const output = await run(input, job);
  return isWebp(output) ? output : null;
}

/** Whether this server can read image details. */
export async function imageMetadataAvailable() {
  return (await currentMetadataReader()) !== null;
}

/**
 * The details of the image in this open file or these bytes, as the decoding process's JSON (which
 * the caller still has to check), or null if they can't be read.
 */
export async function readImageMetadata(input: number | Buffer, job: MetadataJob) {
  const run = await currentMetadataReader();
  return run ? run(input, job) : null;
}
