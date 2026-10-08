import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { copyOrMove, deleteEntries, listTrash, PartialTransferError, restoreTrashItems } from "../lib/files";

async function withTempRoot<T>(run: (root: string) => Promise<T>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-transfer-")));
  const original = { root: config.root, trashEnabled: config.trashEnabled };
  config.root = root;
  config.trashEnabled = true;
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("moves report where each item went so the move can be undone", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "inbox"));
    await fs.mkdir(path.join(root, "archive"));
    await fs.writeFile(path.join(root, "inbox", "a.txt"), "a");
    const moved = await copyOrMove(["inbox/a.txt"], "archive", true);
    assert.deepEqual(moved, [{ source: "inbox/a.txt", path: "archive/a.txt", renamed: false }]);

    const undone = await copyOrMove(moved.map((item) => item.path), "inbox", true);
    assert.deepEqual(undone, [{ source: "archive/a.txt", path: "inbox/a.txt", renamed: false }]);
    assert.equal(await fs.readFile(path.join(root, "inbox", "a.txt"), "utf8"), "a");
  });
});

test("copies into a folder that already has the name get a free copy name", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "report.pdf"), "r");
    await fs.mkdir(path.join(root, "photos"));
    const first = await copyOrMove(["report.pdf", "photos"], "", false);
    assert.deepEqual(first.map((item) => [item.path, item.renamed]), [["report (copy).pdf", true], ["photos (copy)", true]]);
    const second = await copyOrMove(["report.pdf"], "", false);
    assert.equal(second[0].path, "report (copy 2).pdf");
    assert.equal(await fs.readFile(path.join(root, "report (copy 2).pdf"), "utf8"), "r");
  });
});

test("moves still refuse to replace an existing item or stay in place", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "x.txt"), "new");
    await fs.writeFile(path.join(root, "dest", "x.txt"), "old");
    await assert.rejects(copyOrMove(["x.txt"], "dest", true), /already exists/);
    await assert.rejects(copyOrMove(["x.txt"], "", true), /already in that folder/);
    assert.equal(await fs.readFile(path.join(root, "dest", "x.txt"), "utf8"), "old");
  });
});

test("a move that fails part-way reports the items that already moved", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "a"));
    await fs.mkdir(path.join(root, "b"));
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "a", "x.txt"), "a");
    await fs.writeFile(path.join(root, "b", "x.txt"), "b");
    await assert.rejects(copyOrMove(["a/x.txt", "b/x.txt"], "dest", true), (error: unknown) => {
      assert.ok(error instanceof PartialTransferError);
      assert.deepEqual(error.completed, [{ source: "a/x.txt", path: "dest/x.txt", renamed: false }]);
      assert.match(error.message, /already exists.*1 item was moved before this/);
      return true;
    });
    assert.equal(await fs.readFile(path.join(root, "b", "x.txt"), "utf8"), "b");
  });
});

test("a folder cannot be moved or copied into itself or a subfolder", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "projects", "site"), { recursive: true });
    for (const move of [true, false]) {
      await assert.rejects(copyOrMove(["projects"], "projects", move), /into itself/);
      await assert.rejects(copyOrMove(["projects"], "projects/site", move), /into itself/);
    }
    assert.deepEqual(await fs.readdir(path.join(root, "projects")), ["site"]);
  });
});

test("deleting to trash returns ids that restore the items", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "keep.txt"), "k");
    const result = await deleteEntries(["keep.txt"]);
    assert.equal(result.trashed.length, 1);
    assert.equal(result.trashed[0].path, "keep.txt");
    assert.equal((await listTrash()).items[0].id, result.trashed[0].id);
    await restoreTrashItems(result.trashed.map((item) => item.id));
    assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "k");
    assert.deepEqual(await deleteEntries(["keep.txt"], true), { trashed: [] });
  });
});
