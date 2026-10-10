import assert from "node:assert/strict";
import { existsSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import sharp from "sharp";
import { config } from "../lib/config";
import { type MetadataJob, MAX_EXIF_BYTES, imageMetadataAvailable, readImageMetadata, setImageMetadataReader, setImageResizer } from "../lib/image-resize";
import { mediaInfoFor, parseImageMetadata } from "../lib/media-info";
import { thumbnailFor } from "../lib/thumbnails";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-image-details-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    setImageMetadataReader(undefined);
    setImageResizer(undefined);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } } });
const job = (formats: string[], maxBytes = 1024 * 1024): MetadataJob => ({ formats, maxBytes });
const details = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields));

// A PNG claiming other dimensions in its header (only the header is read for details).
function claimingSize(png: Buffer, width: number, height: number) {
  const patched = Buffer.from(png);
  patched.writeUInt32BE(width, 16);
  patched.writeUInt32BE(height, 20);
  patched.writeUInt32BE(zlib.crc32(patched.subarray(12, 29)), 29);
  return patched;
}

// An EXIF block (a TIFF structure) of this size, naming the camera's maker.
function exifNaming(make: string, size: number) {
  const tiff = Buffer.alloc(size);
  tiff.write("II*\0", 0, "latin1");
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x010f, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(make.length + 1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.write(`${make}\0`, 26, "latin1");
  return tiff;
}

// A PNG with that EXIF block, in an eXIf chunk.
function withExifChunk(png: Buffer, make: string, size: number) {
  const tiff = exifNaming(make, size);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(tiff.length, 0);
  header.write("eXIf", 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([header.subarray(4), tiff])), 0);
  // After the signature and the IHDR chunk.
  return Buffer.concat([png.subarray(0, 33), header, tiff, crc, png.subarray(33)]);
}

test("image details are read outside FilesDude, from the open file, and cached", async () => {
  await withRoot(async (root) => {
    await picture(64, 32).png().toFile(path.join(root, "pic.png"));
    const original = await fs.readFile(path.join(root, "pic.png"));
    const calls: Array<{ bytes: Buffer; job: MetadataJob }> = [];
    setImageMetadataReader(async (input, given) => {
      assert.equal(typeof input, "number", "an open file, never a path or a copy");
      const bytes = Buffer.alloc(original.length + 10);
      const read = readSync(input as number, bytes, 0, bytes.length, 0);
      calls.push({ bytes: bytes.subarray(0, read), job: given });
      return details({ format: "png", width: 64, height: 32, depth: "uchar", space: "srgb", hasAlpha: false });
    });
    assert.deepEqual(await mediaInfoFor("pic.png"), { kind: "image", format: "PNG", width: 64, height: 32, bitDepth: "8-bit", colorSpace: "SRGB" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].bytes.equals(original));
    assert.deepEqual(calls[0].job, { formats: ["jpeg", "png", "gif", "webp", "heif"], maxBytes: original.length });
    await mediaInfoFor("pic.png");
    assert.equal(calls.length, 1, "the second request is served from the cache");
  });
});

test("the decoding process's details are only used when every field is as expected", async () => {
  const good = { format: "jpeg", width: 400, height: 300, depth: "uchar", space: "b-w", hasAlpha: false, orientation: 6, exif: exifNaming("Nikon", 64).toString("base64") };
  assert.deepEqual(parseImageMetadata(details(good)), { kind: "image", format: "JPEG", width: 300, height: 400, bitDepth: "8-bit", colorSpace: "Greyscale", camera: "Nikon" });
  assert.deepEqual(parseImageMetadata(details({ format: "gif", width: 20, height: 30, pageHeight: 10, pages: 3 })), { kind: "image", format: "GIF", width: 20, height: 10, frames: 3 });
  assert.deepEqual(parseImageMetadata(details({ format: "heif", width: 2, height: 2, depth: "ushort" })), { kind: "image", format: "AVIF", width: 2, height: 2, bitDepth: "16-bit" });
  // A long animation is still within the pixel limit.
  assert.equal(parseImageMetadata(details({ format: "gif", width: 10, height: 2_000_000, pageHeight: 10, pages: 200_000 }))?.frames, 200_000);
  const refused: Array<Record<string, unknown>> = [
    { ...good, format: "tiff" },
    { ...good, format: "svg" },
    { ...good, width: undefined },
    { ...good, height: 0 },
    { ...good, width: 1.5 },
    { ...good, width: "400" },
    { ...good, width: 20_000, height: 20_000 },
    { ...good, pageHeight: 301 },
    { ...good, pages: -1 },
    { ...good, depth: "<b>" },
    { ...good, space: "sRGB ‮" },
    { ...good, hasAlpha: "yes" },
    { ...good, orientation: 9 },
    { ...good, exif: "not base64!" },
    { ...good, exif: "A".repeat(Math.ceil(MAX_EXIF_BYTES / 3) * 4 + 4) },
    { ...good, comment: "unexpected" },
  ];
  for (const fields of refused) assert.equal(parseImageMetadata(details(fields)), null, JSON.stringify(fields).slice(0, 80));
  for (const output of ["", "not json", "null", "[]", "42", '{"__proto__":{"format":"png"},"format":"png","width":1,"height":1}']) assert.equal(parseImageMetadata(Buffer.from(output)), null, output);

  await withRoot(async (root) => {
    await picture(10, 10).png().toFile(path.join(root, "pic.png"));
    setImageMetadataReader(async () => details({ ...good, format: "tiff" }));
    await assert.rejects(mediaInfoFor("pic.png"), /couldn't be read/);
  });
});

test("an image that can't be read waits an hour, a failed run a minute, and a changed file isn't remembered", async () => {
  await withRoot(async (root) => {
    for (const name of ["bad.png", "slow.png", "growing.png"]) await picture(10, 10).png().toFile(path.join(root, name));
    const calls: string[] = [];
    const answers: Record<string, Array<Buffer | null>> = {
      // The process's answer for an image it can't read, then a failed run, then a changed file.
      "bad.png": [Buffer.from("null")],
      "slow.png": [null, details({ format: "png", width: 10, height: 10 })],
      "growing.png": [Buffer.from('"changed"'), details({ format: "png", width: 10, height: 10 })],
    };
    let current = "";
    setImageMetadataReader(async () => {
      calls.push(current);
      return answers[current].shift() ?? null;
    });
    const read = (name: string) => {
      current = name;
      return mediaInfoFor(name);
    };
    await assert.rejects(read("bad.png"), /couldn't be read/);
    await assert.rejects(read("slow.png"), /couldn't be read/);
    await assert.rejects(read("growing.png"), (error: Error & { status?: number }) => /changed while/.test(error.message) && error.status === 409);
    assert.equal((await read("growing.png")).width, 10, "a changed file is read again at once");
    await assert.rejects(read("bad.png"), /couldn't be read/);
    await assert.rejects(read("slow.png"), /couldn't be read/);
    assert.deepEqual(calls, ["bad.png", "slow.png", "growing.png", "growing.png"]);
    const now = Date.now;
    Date.now = () => now() + 2 * 60 * 1000;
    try {
      assert.equal((await read("slow.png")).width, 10, "a failed run is tried again after a minute");
      await assert.rejects(read("bad.png"), /couldn't be read/);
      assert.equal(calls.length, 5, "an image that couldn't be read waits longer");
    } finally {
      Date.now = now;
    }
  });
});

test("without a safe way to read them, images have no details", async () => {
  await withRoot(async (root) => {
    await picture(10, 10).png().toFile(path.join(root, "pic.png"));
    setImageMetadataReader(null);
    assert.equal(await imageMetadataAvailable(), false);
    await assert.rejects(mediaInfoFor("pic.png"), /Image details aren't available/);
  });
});

test("image details and thumbnails share the two image slots", async () => {
  await withRoot(async (root) => {
    const names = ["1.png", "2.png", "3.png", "4.png"];
    for (const name of names) await picture(8, 8).png().toFile(path.join(root, name));
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const busy = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    };
    setImageMetadataReader(async () => {
      await busy();
      return details({ format: "png", width: 8, height: 8 });
    });
    setImageResizer(async () => {
      await busy();
      return picture(8, 8).webp().toBuffer();
    });
    const results = Promise.all([mediaInfoFor("1.png", "alice"), mediaInfoFor("2.png", "bob"), thumbnailFor("3.png"), thumbnailFor("4.png")]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(releases.length, 2, "the others wait their turn");
    while ((await Promise.race([results.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20))])) === false) releases.shift()?.();
    await results;
    assert.equal(most, 2);
  });
});

// The real decoding process: a separate process on development machines, the sandbox as root on Linux.
test("the decoding process reads only the formats, amount, and pixels it is allowed", async () => {
  setImageMetadataReader(undefined);
  const read = async (input: Buffer, given: MetadataJob) => {
    const output = await readImageMetadata(input, given);
    return output && parseImageMetadata(output);
  };
  // What the process answers: its JSON, or nothing if the run failed.
  const raw = async (input: Buffer, given: MetadataJob) => (await readImageMetadata(input, given))?.toString() ?? null;
  const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: "#08f8" } }).png().toBuffer();
  assert.deepEqual(await read(png, job(["png"])), { kind: "image", format: "PNG", width: 30, height: 20, bitDepth: "8-bit", colorSpace: "SRGB", hasAlpha: true });
  const jpeg = await picture(40, 20).jpeg().withExif({ IFD0: { Make: "Canon", Model: "Canon EOS R6" } }).toBuffer();
  assert.equal((await read(jpeg, job(["jpeg"])))?.camera, "Canon EOS R6");
  assert.equal(await raw(jpeg, job(["png"])), "null", "a JPEG where only PNGs are allowed");
  assert.equal(await raw(png, job(["png"], png.length - 1)), '"changed"', "more bytes than expected");
  assert.equal(await raw(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/>"), job(["png", "svg"])), "null", "an SVG isn't read");
  assert.equal(await raw(await picture(20, 20).tiff().toBuffer(), job(["tiff", "png"])), "null", "TIFF has no decoder here");
  assert.equal(await raw(png.subarray(0, 20), job(["png"])), "null", "a truncated header");
  // Frames are counted, all of them towards the pixel limit.
  const frames = await Promise.all([0, 1, 2].map((index) => picture(20, 10).modulate({ hue: index * 90 }).png().toBuffer()));
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  assert.deepEqual(await read(gif, job(["gif"])), { kind: "image", format: "GIF", width: 20, height: 10, frames: 3, bitDepth: "8-bit", colorSpace: "SRGB", hasAlpha: true });
  // At most 100 megapixels, read from the header alone.
  assert.equal((await read(claimingSize(png, 9000, 9000), job(["png"])))?.width, 9000);
  assert.equal(await raw(claimingSize(png, 10_001, 10_000), job(["png"])), "null", "over 100 megapixels");
  // A large EXIF block is left out; the other details remain.
  assert.equal((await read(withExifChunk(png, "Fujifilm", 1024), job(["png"])))?.camera, "Fujifilm");
  const large = await read(withExifChunk(png, "Fujifilm", MAX_EXIF_BYTES + 1), job(["png"]));
  assert.deepEqual([large?.width, large?.camera], [30, undefined]);
  const avif = await picture(40, 20).avif().toBuffer();
  assert.equal((await read(avif, job(["heif"])))?.format, "AVIF");
});

// On a Linux host with systemd, as root (like the deployed service): the real sandbox.
const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/systemd-run");

test("a real image's details are read in its sandbox", { skip: !realSandbox && "needs Linux, root, and systemd" }, async () => {
  await withRoot(async (root) => {
    setImageMetadataReader(undefined);
    assert.equal(await imageMetadataAvailable(), true);
    await picture(400, 300)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Make: "Canon", Model: "Canon EOS R6" }, IFD2: { DateTimeOriginal: "2024:07:14 18:22:05" } })
      .toFile(path.join(root, "photo.jpg"));
    // Readable only by a uid the sandbox's temporary user isn't: the open file is what it reads.
    await fs.chmod(path.join(root, "photo.jpg"), 0o600);
    assert.deepEqual(await mediaInfoFor("photo.jpg"), {
      kind: "image", format: "JPEG", width: 300, height: 400, bitDepth: "8-bit", colorSpace: "SRGB", camera: "Canon EOS R6", taken: "2024-07-14 18:22:05",
    });
  });
});
