import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MOUNT_DIR, runProgram, sandboxRunner } from "./media-sandbox";

// Makes thumbnails from images. sharp (libvips and the decoders under it) parses files that other
// people control, anyone with an upload link included, so it never decodes them inside FilesDude:
// a separate Node.js process does, given the already-verified open file (or a video frame's bytes)
// as standard input, never a path, and returning the thumbnail on standard output. When FilesDude
// runs as root, that process runs in the same throwaway sandbox as ffmpeg (see media-sandbox.ts),
// with Node.js and its packages shown to it read-only, and without that sandbox images get no
// thumbnails. Otherwise (a development machine, or a service running as an unprivileged account) it
// runs as this account with this account's access, which only keeps a crash or runaway decode from
// taking FilesDude down. Either way only the decoders for the allowed formats can run at all.

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

export const THUMBNAIL_SIZE = 320;
export const MAX_SOURCE_PIXELS = 100_000_000;
const DECODE_TIMEOUT_SECONDS = 10;
// Starting Node.js and sharp, on top of the decode itself.
const RUN_SECONDS = DECODE_TIMEOUT_SECONDS + 5;
const QUALITY = 72;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// A decoder that couldn't be started is tried again after a while.
const RETRY_MS = 10 * 60 * 1000;
// A 1×1 PNG, to check that a decoder works before relying on it.
const SAMPLE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQI12P4//8/AAX+Av7czFnnAAAAAElFTkSuQmCC", "base64");

// The decoding process, run as `node -e`. It reads at most maxBytes from standard input, turns off
// every decoder but those for the formats it was asked for (so nothing else ever parses the file),
// accepts AVIF but no other HEIF, and writes the WebP with plain writes (asking Node.js for
// process.stdout would probe the socket it is, which the sandbox's system-call filter forbids).
const WORKER = String.raw`
"use strict";
const fs = require("fs");
const job = JSON.parse(process.argv[1]);
const chunks = [];
let size = 0;
const buffer = Buffer.alloc(1 << 20);
for (;;) {
  const read = fs.readSync(0, buffer, 0, buffer.length, null);
  if (!read) break;
  size += read;
  if (size > job.maxBytes) process.exit(3);
  chunks.push(Buffer.from(buffer.subarray(0, read)));
}
const input = Buffer.concat(chunks);
const sharp = require(job.sharp);
sharp.cache(false);
sharp.concurrency(1);
const loaders = { jpeg: "VipsForeignLoadJpeg", png: "VipsForeignLoadPng", gif: "VipsForeignLoadNsgif", webp: "VipsForeignLoadWebp", heif: "VipsForeignLoadHeif" };
sharp.block({ operation: ["VipsForeignLoad"] });
const allowed = job.formats.filter((format) => Object.hasOwn(loaders, format));
if (!allowed.length) process.exit(2);
sharp.unblock({ operation: allowed.map((format) => loaders[format]) });
const options = { limitInputPixels: job.maxPixels, failOn: "error", animated: false };
(async () => {
  const { format, compression } = await sharp(input, options).metadata();
  if (!format || !allowed.includes(format) || (format === "heif" && compression !== "av1")) process.exit(2);
  let image = sharp(input, options).timeout({ seconds: job.seconds });
  if (job.orient) image = image.rotate();
  const output = await image
    .resize(job.size, job.size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: job.quality })
    .toBuffer();
  for (let offset = 0; offset < output.length; ) offset += fs.writeSync(1, output, offset);
  process.exit(0);
})().catch(() => process.exit(1));
`;

function workerArguments(sharpPath: string, job: ResizeJob) {
  const settings = { ...job, sharp: sharpPath, maxPixels: MAX_SOURCE_PIXELS, size: THUMBNAIL_SIZE, quality: QUALITY, seconds: DECODE_TIMEOUT_SECONDS };
  return ["--input-type=commonjs", "-e", WORKER, JSON.stringify(settings)];
}

/** Whether these bytes are a WebP file, as every thumbnail must be. */
export function isWebp(data: Buffer | null): data is Buffer {
  return !!data && data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP";
}

/** How images are decoded for this account: only ever in the sandbox for root. */
export function decodingMode(uid: number | undefined) {
  return uid === 0 ? "sandbox" : "process";
}

/** Node.js and sharp (with the packages it needs) shown to the sandbox, where they run from. */
async function sandboxedResizer(modules: string): Promise<ImageResizer | null> {
  const node = await fs.realpath(process.execPath);
  const run = await sandboxRunner(node, { mounts: [[node, `${MOUNT_DIR}/node`], [modules, `${MOUNT_DIR}/node_modules`]], inspectSockets: true });
  if (!run) return null;
  return (input, job) => run(workerArguments(`${MOUNT_DIR}/node_modules/sharp`, job), input, MAX_OUTPUT_BYTES, RUN_SECONDS);
}

function processResizer(modules: string): ImageResizer {
  // No environment is passed on, though the process could still read anything this account can.
  return (input, job) => runProgram(process.execPath, workerArguments(path.join(modules, "sharp"), job), input, MAX_OUTPUT_BYTES, RUN_SECONDS * 1000, { env: {} });
}

async function workingResizer(): Promise<ImageResizer | null> {
  const mode = decodingMode(typeof process.getuid === "function" ? process.getuid() : undefined);
  // The packages FilesDude itself runs with (a release's own, in production).
  const modules = path.join(process.cwd(), "node_modules");
  const found = existsSync(path.join(modules, "sharp", "package.json")) ? await fs.realpath(modules) : null;
  const candidate = !found ? null : mode === "sandbox" ? await sandboxedResizer(found) : processResizer(found);
  // A sandbox that can't read Node.js or sharp, for example, fails this.
  if (candidate && isWebp(await candidate(SAMPLE, { formats: ["png"], orient: false, maxBytes: SAMPLE.length }))) return candidate;
  console.error(mode === "sandbox"
    ? "Image thumbnails are off: running as root, FilesDude only decodes images in a sandbox, which needs Linux, systemd, and Node.js and its node_modules readable by other users"
    : "Image thumbnails are off: sharp couldn't be run");
  return null;
}

let resizer: ImageResizer | null | undefined;
let retryAt = Infinity;
let choosing: Promise<ImageResizer | null> | null = null;

/** Replaces how images are decoded (tests use a fake); null means image thumbnails are off. */
export function setImageResizer(replacement: ImageResizer | null | undefined) {
  resizer = replacement;
  retryAt = Infinity;
}

async function currentResizer() {
  if (resizer !== undefined && !(resizer === null && Date.now() >= retryAt)) return resizer;
  choosing ??= workingResizer().catch(() => null).then((chosen) => {
    resizer = chosen;
    retryAt = chosen ? Infinity : Date.now() + RETRY_MS;
    choosing = null;
    return chosen;
  });
  return choosing;
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
