import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { deleteEntries, deleteTrashItems, emptyTrash, listTrash, restoreTrashItems } from "../lib/files";

async function withTempRoot<T>(run: (root: string) => Promise<T>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-trash-")));
  const original = { root: config.root, trashEnabled: config.trashEnabled };
  config.root = root;
  config.trashEnabled = true;
  try {
    return await run(root);
  } finally {
    config.root = original.root;
    config.trashEnabled = original.trashEnabled;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

test("trashed items record their origin and restore to it", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "report.txt"), "hello");
    await fs.writeFile(path.join(root, "docs", "nested", "a.bin"), Buffer.alloc(300));

    await deleteEntries(["docs/report.txt", "docs/nested"]);
    assert.equal(await exists(path.join(root, "docs", "report.txt")), false);

    const listing = await listTrash();
    assert.equal(listing.items.length, 2);
    const report = listing.items.find((item) => item.name === "report.txt")!;
    const nested = listing.items.find((item) => item.name === "nested")!;
    assert.equal(report.originalPath, "docs/report.txt");
    assert.equal(report.type, "file");
    assert.equal(report.size, 5);
    assert.equal(nested.type, "directory");
    assert.equal(nested.size, 300);
    assert.equal(listing.totalBytes, 305);

    const restored = await restoreTrashItems([report.id, nested.id]);
    assert.deepEqual(restored.map((item) => [item.path, item.renamed]), [["docs/report.txt", false], ["docs/nested", false]]);
    assert.equal(await fs.readFile(path.join(root, "docs", "report.txt"), "utf8"), "hello");
    assert.equal(await exists(path.join(root, "docs", "nested", "a.bin")), true);
    assert.equal((await listTrash()).items.length, 0);
    assert.deepEqual(await fs.readdir(path.join(root, ".filedude", "trash-info")), []);
  });
});

test("restore recreates missing folders and never overwrites existing items", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "b", "note.txt"), "old");
    await fs.writeFile(path.join(root, "top.txt"), "first");
    await deleteEntries(["a/b/note.txt", "top.txt"]);
    await fs.rm(path.join(root, "a"), { recursive: true });
    await fs.writeFile(path.join(root, "top.txt"), "second");

    const ids = Object.fromEntries((await listTrash()).items.map((item) => [item.name, item.id]));
    const restored = await restoreTrashItems([ids["note.txt"], ids["top.txt"]]);
    assert.deepEqual(restored.map((item) => [item.path, item.renamed]), [["a/b/note.txt", false], ["top (restored).txt", true]]);
    assert.equal(await fs.readFile(path.join(root, "a", "b", "note.txt"), "utf8"), "old");
    assert.equal(await fs.readFile(path.join(root, "top.txt"), "utf8"), "second");
    assert.equal(await fs.readFile(path.join(root, "top (restored).txt"), "utf8"), "first");
  });
});

test("restore refuses a parent that has become a file", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "x.txt"), "x");
    await deleteEntries(["docs/x.txt"]);
    await fs.rm(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs"), "now a file");
    const [item] = (await listTrash()).items;
    await assert.rejects(restoreTrashItems([item.id]), /no longer a folder/);
    assert.equal((await listTrash()).items.length, 1);
  });
});

test("items trashed before origin tracking are listed and restored to the root", async () => {
  await withTempRoot(async (root) => {
    const trash = path.join(root, ".filedude", "trash");
    await fs.mkdir(trash, { recursive: true });
    await fs.writeFile(path.join(trash, "old.log.1700000000000-abc123"), "legacy");

    const [item] = (await listTrash()).items;
    assert.equal(item.name, "old.log");
    assert.equal(item.originalPath, null);
    assert.equal(item.deletedAt, new Date(1700000000000).toISOString());
    assert.equal(item.size, 6);

    const [restored] = await restoreTrashItems([item.id]);
    assert.equal(restored.path, "old.log");
    assert.equal(await fs.readFile(path.join(root, "old.log"), "utf8"), "legacy");
  });
});

test("items can be deleted forever individually or by emptying the trash", async () => {
  await withTempRoot(async (root) => {
    for (const name of ["one.txt", "two.txt", "three.txt"]) await fs.writeFile(path.join(root, name), name);
    await deleteEntries(["one.txt", "two.txt", "three.txt"]);
    const [first] = (await listTrash()).items;

    await deleteTrashItems([first.id]);
    assert.equal((await listTrash()).items.length, 2);
    await assert.rejects(deleteTrashItems([first.id]), /no longer in the trash/);

    assert.deepEqual(await emptyTrash(), { removed: 2 });
    assert.equal((await listTrash()).items.length, 0);
    assert.deepEqual(await fs.readdir(path.join(root, ".filedude", "trash")), []);
    assert.deepEqual(await fs.readdir(path.join(root, ".filedude", "trash-info")), []);
  });
});

test("trash operations reject ids that escape the trash folder", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "keep.txt"), "keep");
    await deleteEntries(["keep.txt"]);
    for (const id of ["../trash-info", "..", "a/b", ""]) {
      await assert.rejects(deleteTrashItems([id]), /invalid/);
      await assert.rejects(restoreTrashItems([id]), /invalid/);
    }
    assert.equal((await listTrash()).items.length, 1);
  });
});

test("listing an absent trash is empty and permanent deletes bypass it", async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await listTrash(), { enabled: true, items: [], totalBytes: 0 });
    await fs.writeFile(path.join(root, "gone.txt"), "x");
    await deleteEntries(["gone.txt"], true);
    assert.equal(await exists(path.join(root, ".filedude")), false);
  });
});
