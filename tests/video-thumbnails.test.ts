import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { config } from "../lib/config";
import { thumbnailFor } from "../lib/thumbnails";
import { hiddenPaths } from "../lib/media-sandbox";
import { setFrameRunner, videoThumbnailsAvailable } from "../lib/video-frames";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-video-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    setFrameRunner(undefined);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const frame = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();

test("videos get a thumbnail from one frame, cached, whatever their size", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "clip.mp4"), "VIDEO-BYTES");
    // A large (sparse) video: frames are found by seeking, so size doesn't matter.
    const big = await fs.open(path.join(root, "movie.mkv"), "w");
    await big.truncate(200 * 1024 * 1024);
    await big.close();
    const calls: Array<{ seconds: number; firstBytes: string }> = [];
    setFrameRunner(async (fd, seconds) => {
      const buffer = Buffer.alloc(11);
      readSync(fd, buffer, 0, 11, 0);
      calls.push({ seconds, firstBytes: buffer.toString() });
      return frame(640, 360);
    });
    const first = await thumbnailFor("clip.mp4");
    const meta = await sharp(first.data!).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 320, 180]);
    // The frame source was given the video itself, as an open file.
    assert.deepEqual(calls, [{ seconds: 3, firstBytes: "VIDEO-BYTES" }]);
    assert.deepEqual((await thumbnailFor("clip.mp4")).data, first.data);
    assert.equal(calls.length, 1, "the second request is served from the cache");
    assert.equal((await thumbnailFor("clip.mp4", first.etag)).data, null);
    assert.ok((await thumbnailFor("movie.mkv")).data);
  });
});

test("short clips fall back to the first frame, and videos without one get no thumbnail", async () => {
  await withRoot(async (root) => {
    for (const name of ["short.mov", "broken.mp4", "garbage.webm"]) await fs.writeFile(path.join(root, name), name);
    setFrameRunner(async (fd, seconds) => {
      const name = Buffer.alloc(12);
      const read = readSync(fd, name, 0, 12, 0);
      const file = name.subarray(0, read).toString();
      if (file === "short.mov") return seconds === 0 ? frame(100, 100) : null;
      if (file === "garbage.webm") return Buffer.from("<svg>not a frame</svg>");
      return null;
    });
    assert.ok((await thumbnailFor("short.mov")).data);
    await assert.rejects(thumbnailFor("broken.mp4"), /No frame/);
    await assert.rejects(thumbnailFor("garbage.webm"), /No frame/);
  });
});

test("a video with no frame isn't tried again until it changes", async () => {
  await withRoot(async (root) => {
    const file = path.join(root, "slow.mp4");
    await fs.writeFile(file, "nothing");
    let calls = 0;
    setFrameRunner(async () => {
      calls += 1;
      return null;
    });
    await assert.rejects(thumbnailFor("slow.mp4"), /No frame/);
    assert.equal(calls, 2, "a few seconds in, then the start");
    await assert.rejects(thumbnailFor("slow.mp4"), /No frame/);
    await assert.rejects(Promise.all([thumbnailFor("slow.mp4"), thumbnailFor("slow.mp4")]), /No frame/);
    assert.equal(calls, 2, "later requests are refused without running ffmpeg");
    await fs.writeFile(file, "now with frames");
    setFrameRunner(async () => frame(64, 64));
    assert.ok((await thumbnailFor("slow.mp4")).data, "an edited video is tried afresh");
  });
});

test("one video is worked on at a time, and videos never hold up images", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.mp4", "b.mp4", "c.mp4"]) await fs.writeFile(path.join(root, name), name);
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "#0af" } }).png().toFile(path.join(root, "pic.png"));
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    setFrameRunner(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return frame(64, 64);
    });
    const videos = ["a.mp4", "b.mp4", "c.mp4"].map((name) => thumbnailFor(name));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(releases.length, 1, "the other videos wait their turn");
    assert.ok((await thumbnailFor("pic.png")).data, "an image is made while a video is stuck");
    while ((await Promise.race([Promise.all(videos).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20))])) === false) releases.shift()?.();
    for (const result of await Promise.all(videos)) assert.ok(result.data);
    assert.equal(most, 1);
  });
});

test("the sandbox hides every top-level folder except the system's own", () => {
  const entry = (name: string, link = false) => ({ name, isSymbolicLink: () => link }) as unknown as import("node:fs").Dirent;
  const hidden = hiddenPaths([entry("usr"), entry("bin", true), entry("lib64", true), entry("etc"), entry("run"), entry("proc"), entry("dev"), entry("tmp"), entry("data"), entry("var"), entry("home"), entry("backup"), entry("sys"), entry("mylink", true)]);
  assert.deepEqual(hidden, ["/data", "/var", "/home", "/backup", "/sys"]);
});

test("without a sandbox to run ffmpeg in, videos have no thumbnails", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "clip.mp4"), "x");
    setFrameRunner(null);
    assert.equal(await videoThumbnailsAvailable(), false);
    await assert.rejects(thumbnailFor("clip.mp4"), /aren't available/);
    // Images are unaffected.
    await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toFile(path.join(root, "pic.png"));
    assert.ok((await thumbnailFor("pic.png")).data);
  });
});

// On a Linux host with ffmpeg and systemd, as root (like the deployed service): the real sandbox.
const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/systemd-run");

test("a real video gets a thumbnail from ffmpeg in its sandbox", { skip: !realSandbox && "needs Linux, root, ffmpeg, and systemd" }, async () => {
  await withRoot(async (root) => {
    setFrameRunner(undefined);
    assert.equal(await videoThumbnailsAvailable(), true);
    execFileSync("/usr/bin/ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=640x360:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "test.mp4")]);
    // Readable only by a uid the sandbox's temporary user isn't: the open file is what it reads.
    await fs.chmod(path.join(root, "test.mp4"), 0o600);
    const { data } = await thumbnailFor("test.mp4");
    const meta = await sharp(data!).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 320, 180]);

    // A one-second clip has nothing three seconds in, so its first frame is used.
    execFileSync("/usr/bin/ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "short.mp4")]);
    const short = await sharp((await thumbnailFor("short.mp4")).data!).metadata();
    assert.deepEqual([short.width, short.height], [320, 240]);

    // A playlist dressed up as a video, pointing at another file, is refused rather than followed.
    await fs.writeFile(path.join(root, "playlist.mp4"), `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation><BaseURL>file:${path.join(root, "test.mp4")}</BaseURL></Representation></AdaptationSet></Period></MPD>`);
    await fs.writeFile(path.join(root, "list.mkv"), `#EXTM3U\n#EXTINF:1,\nfile:${path.join(root, "test.mp4")}\n`);
    await assert.rejects(thumbnailFor("playlist.mp4"), /No frame/);
    await assert.rejects(thumbnailFor("list.mkv"), /No frame/);
  });
});
