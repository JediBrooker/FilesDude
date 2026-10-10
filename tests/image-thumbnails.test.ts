import assert from "node:assert/strict";
import { existsSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { config } from "../lib/config";
import { type ResizeJob, decodingMode, imageThumbnailsAvailable, resizeImage, setImageResizer } from "../lib/image-resize";
import { MOUNT_DIR, runProgram, sandboxRunner, unitArguments } from "../lib/media-sandbox";
import { thumbnailFor } from "../lib/thumbnails";
import { setFrameRunner } from "../lib/video-frames";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-images-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    setImageResizer(undefined);
    setFrameRunner(undefined);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 20, g: 90, b: 200 } } });
const webp = (width: number, height: number) => picture(width, height).webp().toBuffer();
const job = (formats: string[], maxBytes = 1024 * 1024): ResizeJob => ({ formats, orient: true, maxBytes });

test("images are decoded outside FilesDude, from the open file, and cached", async () => {
  await withRoot(async (root) => {
    await picture(64, 32).png().toFile(path.join(root, "pic.png"));
    const original = await fs.readFile(path.join(root, "pic.png"));
    const calls: Array<{ bytes: Buffer; job: ResizeJob }> = [];
    setImageResizer(async (input, given) => {
      assert.equal(typeof input, "number", "an open file, never a path or a copy");
      const bytes = Buffer.alloc(original.length + 10);
      const read = readSync(input as number, bytes, 0, bytes.length, 0);
      calls.push({ bytes: bytes.subarray(0, read), job: given });
      return webp(32, 16);
    });
    const first = await thumbnailFor("pic.png");
    assert.equal((await sharp(first.data!).metadata()).format, "webp");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].bytes.equals(original));
    assert.deepEqual(calls[0].job, { formats: ["jpeg", "png", "gif", "webp", "heif"], orient: true, maxBytes: original.length });
    assert.deepEqual((await thumbnailFor("pic.png")).data, first.data);
    assert.equal(calls.length, 1, "the second request is served from the cache");
  });
});

test("video frames are resized outside FilesDude too, as bytes", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "clip.mp4"), "VIDEO");
    const frame = await picture(640, 360).png().toBuffer();
    setFrameRunner(async () => frame);
    const inputs: Array<{ input: number | Buffer; job: ResizeJob }> = [];
    setImageResizer(async (input, given) => {
      inputs.push({ input, job: given });
      return webp(320, 180);
    });
    assert.ok((await thumbnailFor("clip.mp4")).data);
    assert.equal(inputs.length, 1);
    assert.ok(Buffer.isBuffer(inputs[0].input) && inputs[0].input.equals(frame));
    assert.deepEqual(inputs[0].job, { formats: ["png"], orient: false, maxBytes: frame.length });
  });
});

test("a decoder's output is only used when it is a WebP", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.png", "b.png"]) await picture(10, 10).png().toFile(path.join(root, name));
    setImageResizer(async () => picture(10, 10).png().toBuffer());
    await assert.rejects(thumbnailFor("a.png"), /couldn't be read/);
    setImageResizer(async () => null);
    await assert.rejects(thumbnailFor("b.png"), /couldn't be read/);
    assert.equal((await fs.readdir(path.join(config.stateDir, "thumbnails")).catch(() => [])).length, 0, "nothing is cached");
  });
});

test("without a safe way to decode them, images and videos have no thumbnails", async () => {
  await withRoot(async (root) => {
    await picture(10, 10).png().toFile(path.join(root, "pic.png"));
    await fs.writeFile(path.join(root, "clip.mp4"), "VIDEO");
    setFrameRunner(async () => picture(10, 10).png().toBuffer());
    setImageResizer(null);
    assert.equal(await imageThumbnailsAvailable(), false);
    await assert.rejects(thumbnailFor("pic.png"), /Image thumbnails aren't available/);
    await assert.rejects(thumbnailFor("clip.mp4"), /Video thumbnails aren't available/);
  });
});

test("two images are decoded at a time", async () => {
  await withRoot(async (root) => {
    const names = ["1.png", "2.png", "3.png", "4.png"];
    for (const name of names) await picture(8, 8).png().toFile(path.join(root, name));
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    setImageResizer(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return webp(8, 8);
    });
    const results = Promise.all(names.map((name) => thumbnailFor(name)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(releases.length, 2, "the others wait their turn");
    while ((await Promise.race([results.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20))])) === false) releases.shift()?.();
    for (const result of await results) assert.ok(result.data);
    assert.equal(most, 2);
  });
});

test("running as root, images are only ever decoded in the sandbox", () => {
  assert.equal(decodingMode(0), "sandbox");
  assert.equal(decodingMode(1000), "process");
  assert.equal(decodingMode(undefined), "process");
});

test("the sandbox shows Node.js and its packages read-only, and keeps hiding everything else", () => {
  const args = unitArguments("filesdude-media-x", ["/usr/bin/env", `${MOUNT_DIR}/node`, "-e", "code"], 15, ["/opt", "/var"], {
    mounts: [["/opt/node/bin/node", `${MOUNT_DIR}/node`], ["/opt/my app/node_modules", `${MOUNT_DIR}/node_modules`]],
    inspectSockets: true,
  });
  assert.ok(args.includes(`BindReadOnlyPaths=/opt/node/bin/node:${MOUNT_DIR}/node "/opt/my app/node_modules":${MOUNT_DIR}/node_modules`));
  assert.ok(args.some((arg) => arg.startsWith("InaccessiblePaths=-/opt -/var ")));
  for (const property of ["DynamicUser=yes", "PrivateNetwork=yes", "SystemCallFilter=~@network-io", "SystemCallFilter=getsockname getsockopt", "TemporaryFileSystem=/etc:ro /run:ro /dev/shm:size=16M", "MemorySwapMax=0", "SystemCallFilter=~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM", "RuntimeMaxSec=15"]) assert.ok(args.includes(property), property);
  // Only the two harmless socket calls come back, after the rest are taken away.
  assert.ok(args.indexOf("SystemCallFilter=getsockname getsockopt") > args.indexOf("SystemCallFilter=~@network-io"));
  assert.deepEqual(args.slice(-4), ["/usr/bin/env", `${MOUNT_DIR}/node`, "-e", "code"]);
  // Other tools (ffmpeg) get neither.
  const plain = unitArguments("filesdude-media-y", ["/usr/bin/ffmpeg"], 15, []);
  assert.ok(!plain.some((arg) => arg.includes(MOUNT_DIR) || arg === "SystemCallFilter=getsockname getsockopt"));
});

test("mounts outside the sandbox's own folder are refused", async () => {
  assert.equal(await sandboxRunner(process.execPath, { mounts: [[process.execPath, "/usr/bin/node"]] }), null);
  assert.equal(await sandboxRunner(process.execPath, { mounts: [["/a:b", `${MOUNT_DIR}/x`]] }), null);
});

test("a stuck or overly talkative decoder is stopped", async () => {
  const started = Date.now();
  assert.equal(await runProgram(process.execPath, ["-e", "setInterval(() => {}, 1000)"], Buffer.alloc(0), 100, 500), null);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(await runProgram(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], Buffer.alloc(0), 100, 5_000), null);
  assert.equal(await runProgram(process.execPath, ["-e", "process.exit(1)"], Buffer.alloc(0), 100, 5_000), null);
  assert.equal((await runProgram(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0))"], Buffer.from("echo"), 100, 5_000))?.toString(), "echo");
});

// The real decoder: a separate process on development machines, the sandbox as root on Linux.
test("the decoder only reads the formats and amount it is allowed", async () => {
  setImageResizer(undefined);
  const png = await picture(800, 400).png().toBuffer();
  const jpeg = await picture(800, 400).jpeg().toBuffer();
  const made = await resizeImage(png, job(["png"]));
  const meta = await sharp(made!).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 320, 160]);
  assert.equal(await resizeImage(jpeg, job(["png"])), null, "a JPEG where only PNGs are allowed");
  assert.equal(await resizeImage(png, job(["png"], png.length - 1)), null, "more bytes than allowed");
  assert.equal(await resizeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), job(["png", "jpeg"])), null, "an SVG isn't decoded");
  assert.equal(await resizeImage(png.subarray(0, 100), job(["png"])), null, "a truncated image");
  // Only the allowed formats' decoders run at all, whatever the job asks for.
  const tiff = await picture(20, 20).tiff().toBuffer();
  assert.equal(await resizeImage(tiff, job(["tiff", "png"])), null, "TIFF has no decoder here");
  assert.equal(await resizeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/>"), job(["svg"])), null);
  const avif = await picture(40, 20).avif().toBuffer();
  assert.ok(await resizeImage(avif, job(["heif"])), "AVIF is decoded");
});

test("Next.js's own image optimizer, which would decode images in FilesDude, is off", async () => {
  const { default: nextConfig } = await import("../next.config");
  assert.equal(nextConfig.images?.unoptimized, true);
});

// On a Linux host with systemd, as root (like the deployed service): the real sandbox.
const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/systemd-run");

test("a real image gets a thumbnail from its sandbox", { skip: !realSandbox && "needs Linux, root, and systemd" }, async () => {
  await withRoot(async (root) => {
    setImageResizer(undefined);
    assert.equal(await imageThumbnailsAvailable(), true);
    await picture(1200, 600).jpeg().withMetadata({ orientation: 6 }).toFile(path.join(root, "photo.jpg"));
    // Readable only by a uid the sandbox's temporary user isn't: the open file is what it reads.
    await fs.chmod(path.join(root, "photo.jpg"), 0o600);
    const meta = await sharp((await thumbnailFor("photo.jpg")).data!).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 160, 320]);
    // Video frames go through it as bytes.
    await fs.writeFile(path.join(root, "clip.mp4"), "VIDEO");
    setFrameRunner(async () => picture(640, 360).png().toBuffer());
    const frame = await sharp((await thumbnailFor("clip.mp4")).data!).metadata();
    assert.deepEqual([frame.width, frame.height], [320, 180]);
  });
});

test("Node.js in the sandbox sees nothing of FilesDude and has no network", { skip: !realSandbox && "needs Linux, root, and systemd" }, async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "secret.txt"), "secret");
    await fs.mkdir(config.stateDir, { recursive: true });
    const node = await fs.realpath(process.execPath);
    const run = await sandboxRunner(node, { mounts: [[node, `${MOUNT_DIR}/node`], [await fs.realpath("node_modules"), `${MOUNT_DIR}/node_modules`]], inspectSockets: true });
    assert.ok(run);
    const probe = `
      const fs = require("fs");
      const tries = (read) => { try { read(); return "read"; } catch (error) { return error.code; } };
      const report = {
        uid: process.getuid(),
        input: fs.readFileSync(0, "utf8"),
        root: tries(() => fs.readFileSync(${JSON.stringify(path.join(root, "secret.txt"))})),
        state: tries(() => fs.readdirSync(${JSON.stringify(config.stateDir)})),
        config: tries(() => fs.readdirSync("/etc/filesdude")),
        var: tries(() => fs.readdirSync("/var/lib")),
        modules: tries(() => fs.writeFileSync("${MOUNT_DIR}/node_modules/x", "x")),
      };
      fs.writeSync(1, JSON.stringify(report));
    `;
    const report = JSON.parse((await run(["-e", probe], Buffer.from("given"), 10_000))!.toString());
    assert.notEqual(report.uid, 0);
    assert.equal(report.input, "given");
    for (const key of ["root", "state", "config", "var", "modules"]) assert.notEqual(report[key], "read", key);
    // Arguments systemd would rewrite are refused.
    assert.equal(await run(["-e", "require('fs').writeSync(1, '$HOME')"], Buffer.alloc(0), 100), null);
    // Any socket call ends the process.
    assert.equal(await run(["-e", "require('net').connect(80, '1.1.1.1'); setTimeout(() => require('fs').writeSync(1, 'connected'), 2000)"], Buffer.alloc(0), 100), null);
  });
});
