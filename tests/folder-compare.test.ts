import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { compareFolders, startSyncJob, type CompareDifference, type FolderComparison, type SyncItem } from "../lib/folder-compare";
import { copyOrMove, listTrash } from "../lib/files";
import { waitForJob } from "../lib/jobs";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>, trashEnabled = true) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-compare-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir, trashEnabled: config.trashEnabled };
  Object.assign(config, { root, stateDir: path.join(base, "state"), trashEnabled });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function write(root: string, files: Record<string, string>, mtime?: Date) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
    if (mtime) await fs.utimes(path.join(root, name), mtime, mtime);
  }
}

const OLD = new Date("2024-01-01T10:00:00Z");
const NEW = new Date("2025-06-01T10:00:00Z");
const summary = (result: FolderComparison) => Object.fromEntries(result.differences.map((item) => [item.path, item.status === "changed" ? `changed:${item.newer ?? ""}${item.contentsDiffer ? ":contents" : ""}` : item.status]));
const bases = (result: FolderComparison) => ({ left: result.leftId, right: result.rightId });
const plan = (result: FolderComparison, choices: Record<string, "left" | "right">): SyncItem[] => Object.entries(choices).map(([itemPath, to]) => {
  const item = result.differences.find((difference) => difference.path === itemPath) as CompareDifference;
  assert.ok(item, itemPath);
  return { path: item.path, to, left: item.left ?? null, right: item.right ?? null };
});

test("the two folders' differences: what one side lacks, what changed, and what differs in kind", async () => {
  await withRoot(async (root) => {
    await write(root, {
      "a/same.txt": "same", "b/same.txt": "same",
      "a/only-left.txt": "l", "b/only-right.txt": "r",
      "a/new-folder/deep/x.txt": "x",
      "a/sizes.txt": "longer", "b/sizes.txt": "short",
      "a/sub/inner.txt": "same", "b/sub/inner.txt": "same", "a/sub/inner-left.txt": "1",
      "a/kind": "a file", "b/kind/inside.txt": "a folder",
      "a/.filedude/secret": "internal",
    }, OLD);
    await write(root, { "a/edited.txt": "version 2" }, NEW);
    await write(root, { "b/edited.txt": "version 1" }, OLD);
    await fs.symlink("same.txt", path.join(root, "a/link"));
    await fs.symlink("other.txt", path.join(root, "b/link"));
    await fs.symlink("sub", path.join(root, "a/folder-link"));
    await fs.symlink("sub", path.join(root, "b/folder-link"));
    const result = await compareFolders("a", "b");
    assert.deepEqual(summary(result), {
      "edited.txt": "changed:left",
      kind: "typeMismatch",
      link: "changed:",
      "new-folder": "onlyLeft",
      "only-left.txt": "onlyLeft",
      "only-right.txt": "onlyRight",
      "sizes.txt": "changed:",
      "sub/inner-left.txt": "onlyLeft",
    });
    assert.equal(result.complete, true);
    // Links are compared by where they point, never followed; FilesDude's own folder is left out.
    assert.deepEqual([result.counts.identical, result.counts.onlyLeft, result.counts.changed], [3, 3, 3]);
    assert.equal(result.differences.find((item) => item.path === "new-folder")?.left?.type, "directory");
  });
});

test("checking contents finds edits that kept the size and time, and ignores times that differ", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/photo.jpg": "AAAA", "b/photo.jpg": "AAAB" }, OLD);
    await write(root, { "a/copy.bin": "same bytes" }, NEW);
    await write(root, { "b/copy.bin": "same bytes" }, OLD);
    assert.deepEqual(summary(await compareFolders("a", "b")), { "copy.bin": "changed:left" });
    assert.deepEqual(summary(await compareFolders("a", "b", { contents: true })), { "photo.jpg": "changed::contents" });
  });
});

test("a folder can't be compared with itself or one inside it, or outside the account's folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/x/y.txt": "y", "home/bob/one/f": "1", "home/bob/two/f": "22", "home/alice/f": "3" });
    await fs.symlink("a", path.join(root, "a-again"));
    for (const [left, right] of [["a", "a"], ["a", "a/x"], ["a/x", "a"], ["", "a"], ["a", "a-again"], ["a-again", "a/x"]]) {
      await assert.rejects(compareFolders(left, right), /neither inside the other/, `${left} | ${right}`);
    }
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.deepEqual(summary(await compareFolders("home/bob/one", "home/bob/two")), { f: "changed:" });
      await assert.rejects(compareFolders("home/bob/one", "home/alice"));
      await assert.rejects(compareFolders("home/bob/one", "../.."));
    });
  });
});

test("comparing stops at its limits and says so", async () => {
  await withRoot(async (root) => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 30; index += 1) files[`a/f${index}`] = String(index);
    await write(root, files);
    await fs.mkdir(path.join(root, "b"));
    const listed = await compareFolders("a", "b", { limits: { entries: 1_000, milliseconds: 60_000, differences: 10 } });
    assert.deepEqual([listed.differences.length, listed.counts.onlyLeft, listed.truncated, listed.complete], [10, 30, true, true]);
    const short = await compareFolders("a", "b", { limits: { entries: 5, milliseconds: 60_000, differences: 10 } });
    assert.deepEqual([short.complete, short.reason], [false, "limit"]);
  });
});

test("syncing copies the chosen differences, replacing older files through the trash, and keeps times", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/new/deep/x.txt": "x", "a/edited.txt": "version 2", "b/only-right.txt": "r", "a/left-alone.txt": "skip me" }, NEW);
    await write(root, { "b/edited.txt": "version 1" }, OLD);
    const before = await compareFolders("a", "b");
    const job = await startSyncJob("owner", "a", "b", plan(before, { new: "right", "edited.txt": "right", "only-right.txt": "left" }), bases(before));
    const { state } = await waitForJob(job.id);
    assert.equal(state.status, "done");
    assert.deepEqual(state.skipped, []);
    assert.equal(await fs.readFile(path.join(root, "b/new/deep/x.txt"), "utf8"), "x");
    assert.equal(await fs.readFile(path.join(root, "b/edited.txt"), "utf8"), "version 2");
    assert.equal(await fs.readFile(path.join(root, "a/only-right.txt"), "utf8"), "r");
    // The replaced copy is in the trash, and the copies keep their modified times.
    const trash = await listTrash();
    assert.deepEqual(trash.items.map((item) => item.originalPath), ["b/edited.txt"]);
    assert.equal((await fs.stat(path.join(root, "b/edited.txt"))).mtimeMs, NEW.getTime());
    assert.equal((await fs.stat(path.join(root, "b/new/deep/x.txt"))).mtimeMs, NEW.getTime());
    // Afterwards only what wasn't chosen differs.
    assert.deepEqual(summary(await compareFolders("a", "b")), { "left-alone.txt": "onlyLeft" });
  });
});

test("items changed since the comparison are left alone, and without the trash nothing is replaced", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/one.txt": "new one", "a/two.txt": "new two", "a/three.txt": "3" }, NEW);
    await write(root, { "b/one.txt": "old one", "b/two.txt": "old two" }, OLD);
    const before = await compareFolders("a", "b");
    // Someone edits one side of each of two items meanwhile, and adds the third on the other side.
    await write(root, { "a/one.txt": "newer still", "b/two.txt": "edited here", "b/three.txt": "made meanwhile" });
    const { state } = await waitForJob((await startSyncJob("owner", "a", "b", plan(before, { "one.txt": "right", "two.txt": "right", "three.txt": "right" }), bases(before))).id);
    assert.deepEqual(state.skipped?.map((item) => [item.path, item.reason]), [["one.txt", "changed"], ["two.txt", "changed"], ["three.txt", "changed"]]);
    assert.equal(await fs.readFile(path.join(root, "b/two.txt"), "utf8"), "edited here");
    assert.equal(await fs.readFile(path.join(root, "b/three.txt"), "utf8"), "made meanwhile");
    assert.equal((await listTrash()).items.length, 0);
  });
  await withRoot(async (root) => {
    await write(root, { "a/f.txt": "new" }, NEW);
    await write(root, { "b/f.txt": "old" }, OLD);
    const before = await compareFolders("a", "b");
    await assert.rejects(startSyncJob("owner", "a", "b", plan(before, { "f.txt": "right" }), bases(before)), /trash is turned off/);
    assert.equal(await fs.readFile(path.join(root, "b/f.txt"), "utf8"), "old");
  }, false);
});

test("sync items stay inside the compared folders and the account's folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/a/f.txt": "f", "home/bob/secret.txt": "s", "home/alice/x.txt": "x" });
    await fs.mkdir(path.join(root, "home/bob/b"));
    const side = { type: "file" as const, size: 1, mtimeMs: 0, modified: "", id: "1:1" };
    await runInScope({ accountKey: "bob", username: "bob", role: "editor", root: "home/bob" }, async () => {
      const items: SyncItem[] = [
        { path: "../secret.txt", to: "right", left: side, right: null },
        { path: "../../alice/x.txt", to: "right", left: side, right: null },
        { path: ".filedude/trash", to: "right", left: side, right: null },
      ];
      const compared = await compareFolders("home/bob/a", "home/bob/b");
      const { state } = await waitForJob((await startSyncJob("bob", "home/bob/a", "home/bob/b", items, bases(compared))).id);
      assert.equal(state.status, "done", JSON.stringify(state));
      assert.deepEqual(state.transferred, []);
      assert.equal(state.skipped?.length, 3);
      assert.deepEqual(await fs.readdir(path.join(root, "home/bob/b")), []);
      await assert.rejects(startSyncJob("bob", "home/bob/a", "home/alice", items, bases(compared)));
      await assert.rejects(startSyncJob("bob", "home/bob/a", "home/bob/a", items, bases(compared)), /neither inside the other/);
    });
  });
});

test("copies keep each item's modified time, folders included", async () => {
  await withRoot(async (root) => {
    await write(root, { "src/folder/file.txt": "f" }, OLD);
    await fs.utimes(path.join(root, "src/folder"), OLD, OLD);
    await fs.mkdir(path.join(root, "dest"));
    await copyOrMove(["src/folder"], "dest", false);
    assert.equal((await fs.stat(path.join(root, "dest/folder/file.txt"))).mtimeMs, OLD.getTime());
    assert.equal((await fs.stat(path.join(root, "dest/folder"))).mtimeMs, OLD.getTime());
  });
});

test("a folder swapped for a link after comparing is never written through", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/cfg/app.conf": "mine", "a/top.txt": "t", "elsewhere/cfg/keep.txt": "theirs" }, NEW);
    await fs.mkdir(path.join(root, "b/cfg"), { recursive: true });
    const before = await compareFolders("a", "b");
    // Another user swaps the right side's folder for a link to somewhere else.
    await fs.rename(path.join(root, "b/cfg"), path.join(root, "b/cfg-moved"));
    await fs.symlink(path.join(root, "elsewhere/cfg"), path.join(root, "b/cfg"));
    const { state } = await waitForJob((await startSyncJob("owner", "a", "b", plan(before, { "cfg/app.conf": "right", "top.txt": "right" }), bases(before))).id);
    assert.deepEqual(state.skipped?.map((item) => [item.path, item.reason]), [["cfg/app.conf", "changed"]]);
    assert.deepEqual(await fs.readdir(path.join(root, "elsewhere/cfg")), ["keep.txt"]);
    assert.equal(await fs.readFile(path.join(root, "b/top.txt"), "utf8"), "t");
    // The whole right folder swapped for a link: nothing starts at all.
    await fs.rename(path.join(root, "b"), path.join(root, "b-real"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "b"));
    await assert.rejects(startSyncJob("owner", "a", "b", plan(before, { "top.txt": "right" }), bases(before)), /changed since they were compared/);
  });
});

test("a file swapped for another of the same size and time isn't replaced", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/f.txt": "newer" }, NEW);
    await write(root, { "b/f.txt": "older" }, OLD);
    const before = await compareFolders("a", "b");
    // A different file, made to look the same.
    await fs.rm(path.join(root, "b/f.txt"));
    await write(root, { "b/f.txt": "other" }, OLD);
    const { state } = await waitForJob((await startSyncJob("owner", "a", "b", plan(before, { "f.txt": "right" }), bases(before))).id);
    assert.deepEqual(state.skipped?.map((item) => item.reason), ["changed"]);
    assert.equal(await fs.readFile(path.join(root, "b/f.txt"), "utf8"), "other");
    assert.equal((await listTrash()).items.length, 0);
  });
});
