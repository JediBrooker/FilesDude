import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { childFolderSizes, folderSize } from "../lib/folder-size";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-size-")));
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

test("a folder's files, folders, and size are counted, with hard links once and links not followed", async () => {
  await withRoot(async (root) => {
    await write(root, { "media/a.txt": "12345", "media/sub/b.txt": "123", "media/sub/deeper/c.txt": "1", "elsewhere/big.bin": "x".repeat(10_000) });
    await fs.mkdir(path.join(root, "media/empty"));
    await fs.link(path.join(root, "media/a.txt"), path.join(root, "media/sub/a-again.txt"));
    await fs.symlink("../elsewhere", path.join(root, "media/to-elsewhere"));
    await fs.symlink("../elsewhere/big.bin", path.join(root, "media/big-link.bin"));
    await write(root, { "media/.filedude/hidden.bin": "x".repeat(5_000) });
    const size = await folderSize("media");
    assert.deepEqual({ bytes: size.bytes, files: size.files, folders: size.folders, complete: size.complete }, { bytes: 9, files: 3, folders: 3, complete: true });
    assert.ok(size.allocated > 0);
    const whole = await folderSize("");
    assert.equal(whole.bytes, 10_009);
  });
});

test("each folder inside a folder is counted for the Size column", async () => {
  await withRoot(async (root) => {
    await write(root, { "top/films/a.mkv": "x".repeat(1000), "top/films/b/c.mkv": "x".repeat(500), "top/music/d.flac": "x".repeat(20), "top/loose.txt": "loose", "top/.filedude/hidden": "x".repeat(9999) });
    await fs.mkdir(path.join(root, "top/empty"));
    await fs.symlink("films", path.join(root, "top/films-link"));
    const { sizes, complete } = await childFolderSizes("top");
    assert.equal(complete, true);
    assert.deepEqual(Object.fromEntries(Object.entries(sizes).map(([name, size]) => [name, [size.bytes, size.files]])), { films: [1500, 2], music: [20, 1], empty: [0, 0] });
    // Out of budget, the folders not reached are left out and the result says so.
    const short = await childFolderSizes("top", undefined, { entries: 4, milliseconds: 60_000 });
    assert.equal(short.complete, false);
    assert.ok(Object.keys(short.sizes).length < 3);
  });
});

test("counting stops at its limits and says so, and can be cancelled", async () => {
  await withRoot(async (root) => {
    for (let index = 0; index < 50; index += 1) await write(root, { [`many/f${index}.txt`]: "x" });
    const limited = await folderSize("many", undefined, { entries: 10, milliseconds: 60_000 });
    assert.deepEqual([limited.complete, limited.reason], [false, "limit"]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(folderSize("many", controller.signal), /cancelled/);
    await assert.rejects(folderSize("many/f1.txt"), /folder/i);
  });
});

test("accounts can only count folders inside their own", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/a.txt": "aa", "home/alice/secret.txt": "ssss" });
    await fs.symlink("../alice", path.join(root, "home/bob/alice-link"));
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.equal((await folderSize("home/bob")).bytes, 2);
      await assert.rejects(folderSize("home/alice"));
      await assert.rejects(folderSize("home/bob/alice-link"));
    });
  });
});
