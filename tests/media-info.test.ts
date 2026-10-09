import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { config } from "../lib/config";
import { mediaInfoFor, parseExif, parseProbe, setProbeRunner } from "../lib/media-info";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-media-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    setProbeRunner(undefined);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const SAMPLE = {
  streams: [
    { codec_name: "h264", profile: "High", codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] },
    { codec_name: "aac", profile: "LC", codec_type: "audio", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
    { codec_name: "ac3", codec_type: "audio", sample_rate: "48000", channels: 6, channel_layout: "5.1(side)" },
    { codec_name: "subrip", codec_type: "subtitle" },
  ],
  format: { format_long_name: "QuickTime / MOV", duration: "3725.400000", bit_rate: "5200000", tags: { TITLE: "Holiday\u0007 ‮movie", Artist: "Me", encoder: "x" } },
};

test("ffprobe's output becomes checked media details", () => {
  const info = parseProbe(Buffer.from(JSON.stringify(SAMPLE)), "video");
  assert.deepEqual(info, {
    kind: "video", format: "QuickTime / MOV", duration: 3725.4, bitRate: 5_200_000,
    // Recorded sideways, so shown the way it plays.
    width: 1080, height: 1920, videoCodec: "H.264 (High)", frameRate: 29.97,
    audioCodec: "AAC (LC)", sampleRate: 48000, channels: "stereo", audioTracks: 2, subtitleTracks: 1,
    title: "Holiday movie", artist: "Me",
  });
  const audio = parseProbe(Buffer.from(JSON.stringify({ streams: [{ codec_name: "flac", codec_type: "audio", sample_rate: "44100", channels: 1 }], format: { format_long_name: "raw FLAC", duration: "3.000000", tags: { ALBUM: "Disc" } } })), "audio");
  assert.deepEqual(audio, { kind: "audio", format: "raw FLAC", duration: 3, audioCodec: "FLAC", sampleRate: 44100, channels: "1 channel", album: "Disc" });
  // Nonsense is dropped field by field, and output with no streams (or no JSON) gives nothing.
  const odd = parseProbe(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: -5, height: "1e9", avg_frame_rate: "1/0", codec_name: { x: 1 } }], format: { duration: "NaN", bit_rate: "-1", tags: "no" } })), "video");
  assert.deepEqual(odd, { kind: "video" });
  assert.equal(parseProbe(Buffer.from(JSON.stringify({ streams: [], format: {} })), "video"), null);
  assert.equal(parseProbe(Buffer.from("not json"), "audio"), null);
  assert.equal(parseProbe(Buffer.from("null"), "audio"), null);
});

test("images report dimensions, format, frames, camera, and date taken", async () => {
  await withRoot(async (root) => {
    await sharp({ create: { width: 300, height: 200, channels: 4, background: "#08f8" } }).png().toFile(path.join(root, "pic.png"));
    assert.deepEqual(await mediaInfoFor("pic.png"), { kind: "image", format: "PNG", width: 300, height: 200, bitDepth: "8-bit", colorSpace: "SRGB", hasAlpha: true });

    // A portrait photo stored sideways, with camera details.
    await sharp({ create: { width: 400, height: 300, channels: 3, background: "#fa0" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Make: "Canon", Model: "Canon EOS R6" }, IFD2: { DateTimeOriginal: "2024:07:14 18:22:05" } })
      .toFile(path.join(root, "photo.jpg"));
    const photo = await mediaInfoFor("photo.jpg");
    assert.equal(photo.format, "JPEG");
    assert.deepEqual([photo.width, photo.height, photo.camera, photo.taken], [300, 400, "Canon EOS R6", "2024-07-14 18:22:05"]);

    const frames = await Promise.all([0, 1, 2].map((index) => sharp({ create: { width: 20, height: 10, channels: 3, background: { r: index * 100, g: 0, b: 0 } } }).png().toBuffer()));
    await sharp(frames, { join: { animated: true } }).gif().toFile(path.join(root, "anim.gif"));
    const gif = await mediaInfoFor("anim.gif");
    assert.deepEqual([gif.format, gif.width, gif.height, gif.frames], ["GIF", 20, 10, 3]);
  });
});

test("malformed EXIF gives no details rather than an error", () => {
  assert.deepEqual(parseExif(undefined), {});
  assert.deepEqual(parseExif(Buffer.from("Exif\0\0MM\0*")), {});
  // An IFD claiming thousands of entries, and entries pointing past the end.
  const tiff = Buffer.alloc(40);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0110, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(200, 14);
  tiff.writeUInt32LE(0xfffffff0, 18);
  tiff.writeUInt16LE(0x8769, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(8, 30);
  assert.deepEqual(parseExif(tiff), {});
  // An Exif pointer whose value lies past the end.
  const pointer = Buffer.alloc(26);
  pointer.write("II", 0, "latin1");
  pointer.writeUInt16LE(42, 2);
  pointer.writeUInt32LE(8, 4);
  pointer.writeUInt16LE(1, 8);
  pointer.writeUInt16LE(0x8769, 10);
  pointer.writeUInt16LE(4, 12);
  pointer.writeUInt32LE(2, 14);
  pointer.writeUInt32LE(0xfffffff0, 18);
  assert.deepEqual(parseExif(pointer), {});
  for (let round = 0; round < 500; round += 1) {
    const noise = Buffer.from(Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)));
    noise.write(round % 2 ? "MM\0*" : "II*\0", 0, "latin1");
    parseExif(noise);
  }
});

test("videos and audio are read once by the probe, and failures aren't retried", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "clip.mov"), "video");
    await fs.writeFile(path.join(root, "song.flac"), "audio");
    await fs.writeFile(path.join(root, "broken.mp3"), "junk");
    const calls: string[] = [];
    setProbeRunner(async (fd) => {
      const name = Buffer.alloc(5);
      const read = readSync(fd, name, 0, 5, 0);
      const contents = name.subarray(0, read).toString();
      calls.push(contents);
      if (contents === "video") return Buffer.from(JSON.stringify(SAMPLE));
      if (contents === "audio") return Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "flac" }], format: { duration: "61" } }));
      return null;
    });
    assert.equal((await mediaInfoFor("clip.mov")).videoCodec, "H.264 (High)");
    assert.deepEqual(await mediaInfoFor("song.flac"), { kind: "audio", duration: 61, audioCodec: "FLAC" });
    await assert.rejects(mediaInfoFor("broken.mp3"), /couldn't be read/);
    await mediaInfoFor("clip.mov");
    await assert.rejects(mediaInfoFor("broken.mp3"), /couldn't be read/);
    assert.deepEqual(calls, ["video", "audio", "junk"]);
    // An edited file is read again.
    await fs.writeFile(path.join(root, "broken.mp3"), "audio");
    assert.equal((await mediaInfoFor("broken.mp3")).audioCodec, "FLAC");
  });
});

test("requests for a file being read share one read, and each account reads a few at a time", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.mp4", "b.mp4", "c.mp4"]) await fs.writeFile(path.join(root, name), name);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setProbeRunner(async () => {
      calls += 1;
      await gate;
      return Buffer.from(JSON.stringify(SAMPLE));
    });
    const shared = ["alice", "bob", "carol", "dave"].map((account) => mediaInfoFor("a.mp4", account));
    const second = mediaInfoFor("b.mp4", "alice");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(mediaInfoFor("c.mp4", "alice"), /still being read/);
    release();
    for (const info of await Promise.all([...shared, second])) assert.equal(info.videoCodec, "H.264 (High)");
    assert.equal(calls, 2, "four requests for a.mp4 made one read");
    assert.ok(await mediaInfoFor("c.mp4", "alice"), "once alice's reads finish she can read more");
  });
});

test("a failed read is tried again after an hour", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "flaky.mp4"), "x");
    let fail = true;
    setProbeRunner(async () => (fail ? null : Buffer.from(JSON.stringify(SAMPLE))));
    await assert.rejects(mediaInfoFor("flaky.mp4"), /couldn't be read/);
    fail = false;
    await assert.rejects(mediaInfoFor("flaky.mp4"), /couldn't be read/);
    const now = Date.now;
    Date.now = () => now() + 61 * 60 * 1000;
    try {
      assert.ok((await mediaInfoFor("flaky.mp4")).videoCodec);
    } finally {
      Date.now = now;
    }
  });
});

test("other files have no media details, and disguised files aren't decoded", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "notes.txt"), "hello");
    await fs.writeFile(path.join(root, "vector.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await fs.writeFile(path.join(root, "song.mp3"), "x");
    await fs.mkdir(path.join(root, "folder.mp4"));
    setProbeRunner(async () => Buffer.from(JSON.stringify(SAMPLE)));
    await assert.rejects(mediaInfoFor("notes.txt"), /no media details/);
    await assert.rejects(mediaInfoFor("folder.mp4"), /no media details/);
    await assert.rejects(mediaInfoFor("vector.png"), /couldn't be read/);
    setProbeRunner(null);
    await assert.rejects(mediaInfoFor("song.mp3"), /aren't available/);
  });
});

// On a Linux host with ffprobe and systemd, as root (like the deployed service): the real sandbox.
const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/ffprobe") && existsSync("/usr/bin/systemd-run");

test("real videos and audio are read by ffprobe in its sandbox", { skip: !realSandbox && "needs Linux, root, ffprobe, and systemd" }, async () => {
  await withRoot(async (root) => {
    const ffmpeg = (...args: string[]) => execFileSync("/usr/bin/ffmpeg", ["-loglevel", "error", "-y", ...args]);
    ffmpeg("-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata", "title=Test clip", path.join(root, "clip.mp4"));
    ffmpeg("-f", "lavfi", "-i", "sine=duration=3", "-metadata", "ARTIST=Band", path.join(root, "tone.flac"));
    for (const name of ["clip.mp4", "tone.flac"]) await fs.chmod(path.join(root, name), 0o600);
    const clip = await mediaInfoFor("clip.mp4");
    assert.deepEqual([clip.kind, clip.width, clip.height, clip.frameRate, clip.videoCodec, clip.audioCodec, clip.title, Math.round(clip.duration!)], ["video", 640, 360, 25, "H.264 (High)", "AAC (LC)", "Test clip", 4]);
    const tone = await mediaInfoFor("tone.flac");
    assert.deepEqual([tone.kind, tone.audioCodec, tone.artist, tone.duration], ["audio", "FLAC", "Band", 3]);
    // A playlist dressed up as audio isn't followed.
    await fs.writeFile(path.join(root, "list.mp3"), `#EXTM3U\n#EXTINF:1,\nfile:${path.join(root, "tone.flac")}\n`);
    await assert.rejects(mediaInfoFor("list.mp3"), /couldn't be read/);
  });
});
