import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { cancelDuplicateScan, checkDuplicateRemoval, duplicateStatus, forgetDuplicatePaths, startDuplicateScan, trashDuplicates, waitForDuplicateScan } from "../lib/duplicates";
import { listTrash, withFilesystemLock } from "../lib/files";

const MB = 1024 * 1024;

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-duplicates-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir, trashEnabled: config.trashEnabled };
  Object.assign(config, { root, stateDir: path.join(base, "state"), trashEnabled: true });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const pattern = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251));

test("duplicates are found by content, hard links count once, and near misses are told apart", async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, "media", "movies"), { recursive: true });
    await fs.mkdir(path.join(root, "torrents"), { recursive: true });
    await fs.mkdir(path.join(root, ".filedude"), { recursive: true });
    const movie = pattern(2 * MB, 1);
    await fs.writeFile(path.join(root, "media", "movies", "film.mkv"), movie);
    await fs.writeFile(path.join(root, "torrents", "film.mkv"), movie);
    await fs.link(path.join(root, "torrents", "film.mkv"), path.join(root, "torrents", "film-linked.mkv"));
    // Same size, differing only at a byte the samples (start, middle, end) don't cover.
    const nearMiss = Buffer.from(movie);
    nearMiss[300_000] ^= 0xff;
    await fs.writeFile(path.join(root, "media", "near-miss.mkv"), nearMiss);
    // Below the minimum, behind a link, or inside FilesDude's own folder: all ignored.
    await fs.writeFile(path.join(root, "small-a.txt"), "same");
    await fs.writeFile(path.join(root, "small-b.txt"), "same");
    await fs.symlink("media/movies/film.mkv", path.join(root, "link.mkv"));
    await fs.writeFile(path.join(root, ".filedude", "copy.mkv"), movie);

    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    const { report, scanning, error } = duplicateStatus();
    assert.equal(error, null);
    assert.equal(scanning, null);
    assert.equal(report?.totalGroups, 1);
    const group = report!.groups[0];
    assert.deepEqual(group.copies.map((copy) => copy.path).sort(), ["media/movies/film.mkv", "torrents/film-linked.mkv", "torrents/film.mkv"]);
    assert.equal(group.wastedBytes, 2 * MB, "two distinct files, so one extra copy");
    assert.equal(new Set(group.copies.map((copy) => copy.inode)).size, 2);
    assert.ok(group.copies.filter((copy) => copy.path.startsWith("torrents/")).every((copy) => copy.links === 2));
  });
});

test("removals always keep a copy, and the report follows what was removed", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.bin", "b.bin", "c.bin"]) await fs.writeFile(path.join(root, name), pattern(MB, 7));
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    assert.throws(() => checkDuplicateRemoval(["a.bin", "b.bin", "c.bin"]), /Keep at least one copy/);
    assert.throws(() => checkDuplicateRemoval(["other.bin"]), /isn't in the duplicate report/);
    assert.deepEqual(checkDuplicateRemoval(["b.bin", "/c.bin"]), ["b.bin", "c.bin"]);
    forgetDuplicatePaths(["b.bin"]);
    assert.equal(duplicateStatus().report?.groups[0].copies.length, 2);
    forgetDuplicatePaths(["c.bin"]);
    assert.equal(duplicateStatus().report?.totalGroups, 0);
  });
});

test("removing copies checks each one against the disk first", async () => {
  await withRoot(async (root) => {
    for (const folder of ["a", "b", "c", "d"]) await fs.mkdir(path.join(root, folder));
    for (const file of ["a/x.bin", "b/x.bin", "c/x.bin", "d/x.bin"]) await fs.writeFile(path.join(root, file), pattern(MB, 9));
    await fs.mkdir(path.join(root, "secret"));
    await fs.writeFile(path.join(root, "secret", "x.bin"), pattern(MB, 9));
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    assert.equal(duplicateStatus().report?.groups[0].copies.length, 5);

    // After the scan: b/x.bin is rewritten, and folder c is swapped for a link to another folder.
    await fs.writeFile(path.join(root, "b", "x.bin"), pattern(MB, 10));
    await fs.rename(path.join(root, "c"), path.join(root, "c-moved"));
    await fs.symlink("secret", path.join(root, "c"));

    const outcome = await withFilesystemLock(() => trashDuplicates(["b/x.bin", "c/x.bin", "d/x.bin"]));
    assert.deepEqual(outcome.trashed.map((item) => item.path), ["d/x.bin"]);
    assert.deepEqual(outcome.changed.sort(), ["b/x.bin", "c/x.bin"]);
    assert.ok(await fs.lstat(path.join(root, "secret", "x.bin")), "the file behind the link is untouched");
    assert.deepEqual((await listTrash()).items.map((item) => item.originalPath), ["d/x.bin"]);
    assert.deepEqual(duplicateStatus().report?.groups[0].copies.map((copy) => copy.path).sort(), ["a/x.bin", "secret/x.bin"]);
  });
});

test("a set must keep a copy that is still unchanged on disk", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.bin", "b.bin"]) await fs.writeFile(path.join(root, name), pattern(MB, 11));
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    // The copy that would be kept is replaced after the scan (for example by moving the other over it).
    await fs.rm(path.join(root, "a.bin"));
    await assert.rejects(withFilesystemLock(() => trashDuplicates(["b.bin"])), /No unchanged copy/);
    assert.ok(await fs.lstat(path.join(root, "b.bin")));
  });
});

test("two scans can't start at once, and tiny minimums are refused", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.bin"), pattern(MB, 1));
    await assert.rejects(startDuplicateScan("", 1), /at least 64 KB/);
    const results = await Promise.allSettled([startDuplicateScan("", MB), startDuplicateScan("", MB)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    await waitForDuplicateScan();
  });
});

test("a scan can be cancelled, and only one runs at a time", async () => {
  await withRoot(async (root) => {
    for (let index = 0; index < 40; index += 1) await fs.writeFile(path.join(root, `copy-${index}.bin`), pattern(4 * MB, 3));
    await startDuplicateScan("", MB);
    await assert.rejects(startDuplicateScan("", MB), /already running/);
    cancelDuplicateScan();
    await waitForDuplicateScan();
    assert.equal(duplicateStatus().scanning, null);
    assert.equal(duplicateStatus().error, null, "cancelling isn't reported as a failure");
  });
});
