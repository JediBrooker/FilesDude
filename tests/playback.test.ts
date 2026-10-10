import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { openPlayback, playbackStatus, preparePlayback, setPlaybackRunners, waitForPlaybackJobs, type PlaybackRunners } from "../lib/playback";
import { runInScope } from "../lib/scope";
import { GET as playback } from "../app/api/fs/playback/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (context: { root: string; state: string; calls: string[][]; owner: string }) => Promise<T>, codecs: Record<string, { video?: string; audio?: string }>, remuxWorks = true) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-playback-")));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  await fs.mkdir(path.join(root, "home", "bob"), { recursive: true });
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  Object.assign(config, { root, stateDir: state, passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("playback-test-password", salt)).toString("base64url")}`, sessionSecret: "playback-test-session-secret-with-more-than-32-chars" });
  const calls: string[][] = [];
  const runners: PlaybackRunners = {
    // Codecs by the file's first bytes, which the tests write as the file's name.
    probe: async (fd) => {
      const name = Buffer.alloc(32);
      const length = readSync(fd, name, 0, 32, 0);
      const which = codecs[name.subarray(0, length).toString().trim()] ?? {};
      return Buffer.from(JSON.stringify({ format: { format_name: "matroska,webm" }, streams: [...(which.video ? [{ codec_type: "video", codec_name: which.video }] : []), ...(which.audio ? [{ codec_type: "audio", codec_name: which.audio }] : [])] }));
    },
    remux: async (args, _input, output) => {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (!remuxWorks) return false;
      writeSync(output, "MP4-DATA-0123456789");
      return true;
    },
  };
  setPlaybackRunners(runners);
  try {
    const credentials = await getCredentials();
    return await run({ root, state, calls, owner: `fd_session=${createSession(credentials.username, credentials.version)}` });
  } finally {
    await waitForPlaybackJobs();
    setPlaybackRunners(undefined);
    Object.assign(config, original);
    delete process.env.FILEDUDE_PLAYBACK_CACHE_GB;
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("a video is repackaged once, copying the picture and making the sound playable", async () => {
  await withRoot(async ({ root, state, calls }) => {
    await fs.writeFile(path.join(root, "episode.mkv"), "hevc-eac3");
    await fs.writeFile(path.join(root, "movie.mkv"), "h264-aac");
    await assert.rejects(playbackStatus("notes.txt"), /Only videos/);
    const before = await playbackStatus("episode.mkv");
    assert.equal(before.state, "none");
    assert.deepEqual(before.codecs, { container: "matroska,webm", video: "hevc", audio: "eac3" });

    assert.equal((await preparePlayback("episode.mkv", "owner")).state, "preparing");
    assert.equal((await playbackStatus("episode.mkv")).state, "preparing");
    await waitForPlaybackJobs();
    assert.equal((await playbackStatus("episode.mkv")).state, "ready");
    const args = calls[0].join(" ");
    assert.match(args, /-protocol_whitelist fd -format_whitelist/);
    assert.match(args, /-c:v copy -tag:v hvc1/);
    assert.match(args, /-c:a aac -b:a 192k -ac 2/);
    assert.match(args, /-f mp4 -fd 1 fd:$/);
    const { handle, size } = await openPlayback("episode.mkv");
    assert.equal((await handle.readFile("utf8")), "MP4-DATA-0123456789");
    assert.equal(size, 19);
    await handle.close();
    assert.equal((await fs.stat(path.join(state, "playback"))).mode & 0o777, 0o700);
    // Asking again uses the copy that's there.
    assert.equal((await preparePlayback("episode.mkv", "owner")).state, "ready");
    assert.equal(calls.length, 1);

    // Sound that plays everywhere is kept as it is.
    await preparePlayback("movie.mkv", "owner");
    await waitForPlaybackJobs();
    assert.match(calls[1].join(" "), /-c:v copy -c:a copy/);
    assert.doesNotMatch(calls[1].join(" "), /hvc1/);

    // A changed video gets a new copy, never the old one.
    await fs.writeFile(path.join(root, "episode.mkv"), "hevc-eac3 ");
    assert.equal((await playbackStatus("episode.mkv")).state, "none");
    await assert.rejects(openPlayback("episode.mkv"), /hasn't been prepared/);
  }, { "hevc-eac3": { video: "hevc", audio: "eac3" }, "h264-aac": { video: "h264", audio: "aac" } });
});

test("pictures that can't be copied, failures, and busy accounts are told apart", async () => {
  await withRoot(async ({ root, calls, state }) => {
    await fs.writeFile(path.join(root, "old.avi"), "mpeg4");
    await fs.writeFile(path.join(root, "a.mkv"), "h264-ac3");
    await fs.writeFile(path.join(root, "b.mkv"), "h264-dts");
    assert.equal((await preparePlayback("old.avi", "owner")).state, "unsupported");
    assert.equal(calls.length, 0);
    // One preparation per account at a time.
    await preparePlayback("a.mkv", "bob");
    await assert.rejects(preparePlayback("b.mkv", "bob"), /Another video is being prepared/);
    await waitForPlaybackJobs();
    // A failed attempt isn't retried straight away, and leaves nothing behind.
    assert.equal((await playbackStatus("a.mkv")).state, "failed");
    assert.deepEqual((await fs.readdir(path.join(state, "playback"))).filter((name) => name.endsWith(".part")), []);
  }, { mpeg4: { video: "mpeg4", audio: "mp3" }, "h264-ac3": { video: "h264", audio: "ac3" }, "h264-dts": { video: "h264", audio: "dts" } }, false);
});

test("copies stay within their total size, the least recently watched going first", async () => {
  await withRoot(async ({ root, state }) => {
    process.env.FILEDUDE_PLAYBACK_CACHE_GB = String(30 / 1024 ** 3);
    for (const name of ["one", "two"]) {
      await fs.writeFile(path.join(root, `${name}.mkv`), "h264-aac");
      await preparePlayback(`${name}.mkv`, "owner");
      await waitForPlaybackJobs();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Each copy is 19 bytes, so only the newest fits in 30.
    const left = (await fs.readdir(path.join(state, "playback"))).filter((name) => name.endsWith(".mp4"));
    assert.equal(left.length, 1);
    assert.equal((await playbackStatus("two.mkv")).state, "ready");
    assert.equal((await playbackStatus("one.mkv")).state, "none");
  }, { "h264-aac": { video: "h264", audio: "aac" } });
});

const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe") && existsSync("/usr/bin/systemd-run");

test("a real video is repackaged by ffmpeg in its sandbox into an MP4 that plays", { skip: !realSandbox && "needs Linux, root, ffmpeg, and systemd" }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-playback-real-")));
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root: path.join(base, "root"), stateDir: path.join(base, "state") });
  await fs.mkdir(config.root);
  setPlaybackRunners(undefined);
  try {
    execFileSync("/usr/bin/ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-c:a", "ac3", path.join(config.root, "clip.mkv")]);
    await fs.chmod(path.join(config.root, "clip.mkv"), 0o600);
    const before = await playbackStatus("clip.mkv");
    assert.deepEqual([before.state, before.codecs?.video, before.codecs?.audio], ["none", "h264", "ac3"]);
    await preparePlayback("clip.mkv", "owner");
    await waitForPlaybackJobs();
    assert.equal((await playbackStatus("clip.mkv")).state, "ready");
    const copy = (await fs.readdir(path.join(config.stateDir, "playback"))).find((name) => name.endsWith(".mp4"))!;
    const streams = execFileSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path.join(config.stateDir, "playback", copy)]).toString().trim().split("\n");
    assert.deepEqual(streams, ["h264", "aac"]);
    // It decodes from start to end without errors.
    assert.equal(execFileSync("/usr/bin/ffmpeg", ["-v", "error", "-i", path.join(config.stateDir, "playback", copy), "-f", "null", "-"]).toString(), "");
  } finally {
    await waitForPlaybackJobs();
    setPlaybackRunners(undefined);
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("an account only reaches videos in its own folder, and the copy is served with ranges", async () => {
  await withRoot(async ({ root, owner }) => {
    await fs.writeFile(path.join(root, "home", "bob", "clip.mkv"), "h264-aac");
    await fs.writeFile(path.join(root, "secret.mkv"), "h264-aac");
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.equal((await playbackStatus("home/bob/clip.mkv")).state, "none");
      await assert.rejects(playbackStatus("secret.mkv"));
      await assert.rejects(preparePlayback("secret.mkv", "bob"));
    });
    await preparePlayback("home/bob/clip.mkv", "owner");
    await waitForPlaybackJobs();
    const get = (range?: string) => playback(new Request("http://localhost/api/fs/playback?path=home/bob/clip.mkv", { headers: { cookie: owner, ...(range ? { range } : {}) } }));
    const whole = await get();
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(await whole.text(), "MP4-DATA-0123456789");
    const part = await get("bytes=4-7");
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 4-7/19");
    assert.equal(await part.text(), "DATA");
    const tail = await get("bytes=-4");
    assert.equal(await tail.text(), "6789");
    assert.equal((await get("bytes=40-")).status, 416);
  }, { "h264-aac": { video: "h264", audio: "aac" } });
});
