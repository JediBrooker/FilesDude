import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { listSubtitles, setSubtitleRunners, srtToVtt, subtitleTrack } from "../lib/subtitles";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string, state: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-subs-")));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: state });
  try {
    return await run(root, state);
  } finally {
    Object.assign(config, original);
    setSubtitleRunners(undefined);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function write(root: string, files: Record<string, string | Buffer>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,000\r\n<i>Second</i>\r\n";

test("SRT becomes WebVTT", () => {
  assert.equal(srtToVtt(SRT), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello there\n\n2\n00:01:00.000 --> 00:01:01.000\n<i>Second</i>\n");
});

test("subtitle files beside a video are offered, labelled by language", async () => {
  await withRoot(async (root) => {
    await write(root, {
      "tv/Show S01E01.mkv": "video",
      "tv/Show S01E01.srt": SRT,
      "tv/Show S01E01.en.forced.srt": SRT,
      "tv/Show S01E01.fr.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nBonjour\n",
      "tv/Show S01E02.en.srt": SRT,
      "tv/Show S01E01.en.srt.txt": "not subtitles",
      // Windows-1252, as older subtitle files often are.
      "tv/Show S01E01.de.srt": Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nGr\xfc\xdfe\n", "latin1"),
    });
    setSubtitleRunners(null);
    const tracks = await listSubtitles("tv/Show S01E01.mkv");
    assert.deepEqual(tracks.map((track) => [track.id, track.label, track.language]), [
      ["file:Show S01E01.de.srt", "German", "de"],
      ["file:Show S01E01.en.forced.srt", "English · forced", "en"],
      ["file:Show S01E01.fr.vtt", "French", "fr"],
      ["file:Show S01E01.srt", "Subtitles", undefined],
    ]);
    assert.match(await subtitleTrack("tv/Show S01E01.mkv", "file:Show S01E01.srt"), /^WEBVTT\n\n1\n00:00:01\.000 --> /);
    assert.match(await subtitleTrack("tv/Show S01E01.mkv", "file:Show S01E01.de.srt"), /Grüße/);
    assert.match(await subtitleTrack("tv/Show S01E01.mkv", "file:Show S01E01.fr.vtt"), /Bonjour/);
    // Only this video's subtitle files, from its own folder.
    for (const id of ["file:Show S01E02.en.srt", "file:../secret.srt", "file:Show S01E01.en.srt.txt", "stream:x", "nonsense"]) {
      await assert.rejects(subtitleTrack("tv/Show S01E01.mkv", id), /Unknown subtitle track/, id);
    }
    await assert.rejects(listSubtitles("tv/Show S01E01.srt"), /Only videos/);
  });
});

test("text subtitles inside a video are listed, extracted once, and kept", async () => {
  await withRoot(async (root, state) => {
    await write(root, { "film.mkv": "video" });
    let extracted = 0;
    setSubtitleRunners({
      probe: async () => Buffer.from(JSON.stringify({ streams: [
        { index: 2, codec_name: "subrip", tags: { language: "eng" } },
        { index: 3, codec_name: "hdmv_pgs_subtitle", tags: { language: "eng" } },
        { index: 4, codec_name: "ass", tags: { language: "jpn", title: "Signs & songs" } },
      ] })),
      extract: async (_fd, stream) => {
        extracted += 1;
        return Buffer.from(`WEBVTT\n\n00:00.000 --> 00:01.000\nstream ${stream}\n`);
      },
    });
    assert.deepEqual((await listSubtitles("film.mkv")).map((track) => [track.id, track.label]), [["stream:2", "English"], ["stream:4", "Signs & songs"]]);
    assert.match(await subtitleTrack("film.mkv", "stream:4"), /stream 4/);
    assert.match(await subtitleTrack("film.mkv", "stream:4"), /stream 4/);
    assert.equal(extracted, 1, "kept after the first time");
    assert.equal((await fs.readdir(path.join(state, "subtitles"))).length, 1);
    // A picture-based track (not offered) can't be asked for.
    await assert.rejects(subtitleTrack("film.mkv", "stream:3"), /Unknown subtitle track/);
  });
});

test("accounts only reach subtitles inside their own folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/clip.mp4": "v", "home/bob/clip.srt": SRT, "home/alice/clip.mp4": "v", "home/alice/clip.srt": SRT });
    setSubtitleRunners(null);
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.equal((await listSubtitles("home/bob/clip.mp4")).length, 1);
      await assert.rejects(listSubtitles("home/alice/clip.mp4"));
      await assert.rejects(subtitleTrack("home/alice/clip.mp4", "file:clip.srt"));
    });
  });
});

const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe") && existsSync("/usr/bin/systemd-run");

test("real embedded subtitles are extracted by ffmpeg in its sandbox", { skip: !realSandbox && "needs Linux, root, ffmpeg, and systemd" }, async () => {
  await withRoot(async (root) => {
    setSubtitleRunners(undefined);
    await write(root, { "subs.srt": SRT });
    execFileSync("/usr/bin/ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=25", "-i", path.join(root, "subs.srt"), "-map", "0", "-map", "1", "-c:v", "libx264", "-c:s", "srt", "-metadata:s:s:0", "language=eng", path.join(root, "movie.mkv")]);
    await fs.chmod(path.join(root, "movie.mkv"), 0o600);
    const tracks = await listSubtitles("movie.mkv");
    assert.deepEqual(tracks.map((track) => [track.label, track.source]), [["English", "embedded"]]);
    const vtt = await subtitleTrack("movie.mkv", tracks[0].id);
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Hello there/);
  });
});
