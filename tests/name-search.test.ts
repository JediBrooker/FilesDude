import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { matchesKind, searchNames } from "../lib/name-search";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-search-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function write(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

const paths = (result: Awaited<ReturnType<typeof searchNames>>) => result.entries.map((entry) => entry.path).sort();

test("names are found anywhere below, without following links or showing hidden and internal items", async () => {
  await withRoot(async (root) => {
    await write(root, { "media/Holiday.mp4": "v", "media/sub/holiday-notes.txt": "n", "media/.hidden/holiday.jpg": "h", "media/.filedude/holiday.bin": "x", "outside/holiday-secret.txt": "s" });
    await fs.symlink("../outside", path.join(root, "media/holiday-link"));
    assert.deepEqual(paths(await searchNames("media", { query: "HOLIDAY" })), ["media/Holiday.mp4", "media/holiday-link", "media/sub/holiday-notes.txt"]);
    assert.deepEqual(paths(await searchNames("media", { query: "holiday", hidden: true })), ["media/.hidden/holiday.jpg", "media/Holiday.mp4", "media/holiday-link", "media/sub/holiday-notes.txt"]);
    const link = (await searchNames("media", { query: "link" })).entries[0];
    assert.equal(link.type, "symlink");
  });
});

test("filters find by kind, age, and size, with or without a name", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/film.mkv": "v", "a/clip.MOV": "v", "a/photo.jpg": "p", "a/raw.CR2": "r", "a/song.flac": "s", "a/report.pdf": "d", "a/sheet.xlsx": "d", "a/backup.tar.gz": "z", "a/disk.iso": "i", "a/code.ts": "c" });
    await fs.mkdir(path.join(root, "a/Folder of things"));
    assert.deepEqual(paths(await searchNames("", { kind: "videos" })), ["a/clip.MOV", "a/film.mkv"]);
    assert.deepEqual(paths(await searchNames("", { kind: "images" })), ["a/photo.jpg", "a/raw.CR2"]);
    assert.deepEqual(paths(await searchNames("", { kind: "documents" })), ["a/report.pdf", "a/sheet.xlsx"]);
    assert.deepEqual(paths(await searchNames("", { kind: "archives" })), ["a/backup.tar.gz", "a/disk.iso"]);
    assert.deepEqual(paths(await searchNames("", { kind: "folders" })), ["a", "a/Folder of things"]);
    assert.deepEqual(paths(await searchNames("", { kind: "folders", query: "things" })), ["a/Folder of things"]);
    // Older than a week, and a large (sparse) file.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(root, "a/film.mkv"), old, old);
    const big = await fs.open(path.join(root, "a/huge.mkv"), "w");
    await big.truncate(2 * 1024 ** 3);
    await big.close();
    assert.deepEqual(paths(await searchNames("", { kind: "videos", modifiedWithinDays: 7 })), ["a/clip.MOV", "a/huge.mkv"]);
    assert.deepEqual(paths(await searchNames("", { minBytes: 1024 ** 3 })), ["a/huge.mkv"]);
    assert.equal(matchesKind("x.ts", false, "videos"), false);
  });
});

test("searches stop at their limits and say so, and can be cancelled", async () => {
  await withRoot(async (root) => {
    for (let index = 0; index < 30; index += 1) await write(root, { [`many/file-${index}.txt`]: "x" });
    const capped = await searchNames("", { query: "file" }, undefined, { results: 10, entries: 1_000, milliseconds: 20_000 });
    assert.deepEqual([capped.entries.length, capped.truncated, capped.stoppedBy], [10, true, "results"]);
    const limited = await searchNames("", { query: "file" }, undefined, { results: 500, entries: 5, milliseconds: 20_000 });
    assert.deepEqual([limited.complete, limited.stoppedBy], [false, "limit"]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchNames("", { query: "file" }, controller.signal), /cancelled/);
  });
});

test("accounts only search inside their own folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/report.txt": "b", "home/alice/report.txt": "a" });
    await fs.symlink("../alice", path.join(root, "home/bob/alice-link"));
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.deepEqual(paths(await searchNames("home/bob", { query: "report" })), ["home/bob/report.txt"]);
      await assert.rejects(searchNames("home/alice", { query: "report" }));
      await assert.rejects(searchNames("", { query: "report" }));
    });
  });
});
