import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { cancelDuplicateScan, checkDuplicateRemoval, duplicateStatus, forgetDuplicatePaths, linkDuplicates, startDuplicateScan, trashDuplicates, waitForDuplicateScan } from "../lib/duplicates";
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

test("copies can be replaced with hard links, keeping every path and sending originals to the trash", async () => {
  await withRoot(async (root) => {
    for (const folder of ["media", "torrents", "other", "changed"]) await fs.mkdir(path.join(root, folder));
    const content = pattern(MB, 21);
    await fs.writeFile(path.join(root, "media", "film.mkv"), content);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const copy of ["torrents/film.mkv", "other/film.mkv", "changed/film.mkv"]) await fs.writeFile(path.join(root, copy), content);
    await fs.chmod(path.join(root, "other", "film.mkv"), 0o600);
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    await fs.writeFile(path.join(root, "changed", "film.mkv"), pattern(MB, 22));

    assert.throws(() => checkDuplicateRemoval(["media/film.mkv", "torrents/film.mkv", "other/film.mkv", "changed/film.mkv"]), /Keep at least one copy/);
    const outcome = await withFilesystemLock(() => linkDuplicates(["torrents/film.mkv", "other/film.mkv", "changed/film.mkv"]));
    assert.deepEqual(outcome.linked.map((item) => [item.path, item.target]), [["torrents/film.mkv", "media/film.mkv"]]);
    assert.deepEqual(outcome.skipped.map((item) => [item.path, item.reason]).sort(), [["changed/film.mkv", "changed"], ["other/film.mkv", "different-owner"]]);

    // The path still works and now shares the kept file's data; the original is in the trash.
    const [kept, linked] = await Promise.all([fs.stat(path.join(root, "media", "film.mkv")), fs.stat(path.join(root, "torrents", "film.mkv"))]);
    assert.equal(linked.ino, kept.ino);
    assert.equal(kept.nlink, 2);
    assert.deepEqual(await fs.readFile(path.join(root, "torrents", "film.mkv")), content);
    assert.deepEqual((await listTrash()).items.map((item) => item.originalPath), ["torrents/film.mkv"]);
    assert.ok(!(await fs.readdir(path.join(root, "torrents"))).some((name) => name.startsWith(".filedude-link-")));

    // The report now counts the linked copy as the same file as the kept one.
    const group = duplicateStatus().report!.groups[0];
    assert.equal(group.copies.find((copy) => copy.path === "torrents/film.mkv")!.inode, group.copies.find((copy) => copy.path === "media/film.mkv")!.inode);
    assert.equal(group.wastedBytes, MB * 2, "other/ and changed/ still hold extra copies");
  });
});

test("hard links are only made to the exact kept file, and never for executable or shared-writable files", async () => {
  await withRoot(async (root) => {
    for (const folder of ["keep", "dup", "exec-keep", "exec-dup", "open-keep", "open-dup"]) await fs.mkdir(path.join(root, folder));
    const write = async (file: string, seed: number, mode = 0o644) => {
      await fs.writeFile(path.join(root, file), pattern(MB, seed));
      await fs.chmod(path.join(root, file), mode);
    };
    await write("keep/a.bin", 30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write("dup/a.bin", 30);
    await write("exec-keep/tool", 31, 0o755);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write("exec-dup/tool", 31, 0o755);
    await write("open-keep/notes.bin", 32, 0o664);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write("open-dup/notes.bin", 32, 0o664);
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();

    // The kept file's name is swapped for another file just as the link is made.
    const original = fs.link;
    let swapped = false;
    Object.assign(fs, {
      link: async (from: string, to: string) => {
        if (!swapped && String(to).includes(".filedude-link-")) {
          swapped = true;
          await fs.writeFile(path.join(root, "keep", "evil.bin"), pattern(MB, 99));
          await fs.rename(path.join(root, "keep", "evil.bin"), path.join(root, "keep", "a.bin"));
        }
        return original(from, to);
      },
    });
    let outcome;
    try {
      outcome = await withFilesystemLock(() => linkDuplicates(["dup/a.bin", "exec-dup/tool", "open-dup/notes.bin"]));
    } finally {
      Object.assign(fs, { link: original });
    }
    assert.ok(swapped);
    assert.deepEqual(outcome.linked, []);
    assert.deepEqual(outcome.skipped.map((item) => [item.path, item.reason]).sort(), [["dup/a.bin", "changed"], ["exec-dup/tool", "permissions"], ["open-dup/notes.bin", "permissions"]]);
    // Nothing was replaced or trashed, and no temporary link was left behind.
    assert.deepEqual(await fs.readFile(path.join(root, "dup", "a.bin")), pattern(MB, 30));
    assert.deepEqual((await listTrash()).items, []);
    assert.deepEqual(await fs.readdir(path.join(root, "dup")), ["a.bin"]);
  });
});

test("if the final link fails, the replaced copy is put back from the trash", async () => {
  await withRoot(async (root) => {
    for (const name of ["a.bin", "b.bin"]) {
      await fs.writeFile(path.join(root, name), pattern(MB, 40));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await startDuplicateScan("", MB);
    await waitForDuplicateScan();
    const original = fs.link;
    Object.assign(fs, {
      link: async (from: string, to: string) => {
        if (String(from).includes(".filedude-link-")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return original(from, to);
      },
    });
    let outcome;
    try {
      outcome = await withFilesystemLock(() => linkDuplicates(["b.bin"]));
    } finally {
      Object.assign(fs, { link: original });
    }
    assert.deepEqual(outcome.skipped.map((item) => item.reason), ["failed"]);
    assert.deepEqual(await fs.readFile(path.join(root, "b.bin")), pattern(MB, 40));
    assert.deepEqual((await listTrash()).items, []);
    assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".")).sort(), ["a.bin", "b.bin"]);
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
