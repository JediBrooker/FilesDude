import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createLink, retargetLink } from "../lib/files";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-links-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(root, ".filedude") });
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

test("a symbolic link stores the way from its folder to the item, and works through it", async () => {
  await withRoot(async (root) => {
    await write(root, { "media/films/film.mkv": "film", "links/.keep": "" });
    const entry = await createLink("media/films/film.mkv", "links", "film.mkv", "symbolic");
    assert.deepEqual([entry.path, entry.type, entry.symlinkTarget, entry.symlinkBlocked], ["links/film.mkv", "symlink", "../media/films/film.mkv", false]);
    assert.equal(await fs.readFile(path.join(root, "links/film.mkv"), "utf8"), "film");
    // Folders too, and beside the item.
    const folder = await createLink("media/films", "media", "films link", "symbolic");
    assert.equal(folder.symlinkTarget, "films");
    assert.deepEqual(await fs.readdir(path.join(root, "media/films link")), ["film.mkv"]);
    // Nothing is replaced.
    await assert.rejects(createLink("media/films/film.mkv", "links", "film.mkv", "symbolic"), /already exists/);
    await assert.rejects(createLink("media/films/film.mkv", "links", "../escape", "symbolic"));
  });
});

test("a hard link is another name for the same file, and only for ordinary files", async () => {
  await withRoot(async (root) => {
    await write(root, { "a/report.pdf": "pdf", "b/.keep": "", "a/tool": "#!/bin/sh" });
    await createLink("a/report.pdf", "b", "report.pdf", "hard");
    const [first, second] = await Promise.all([fs.stat(path.join(root, "a/report.pdf")), fs.lstat(path.join(root, "b/report.pdf"))]);
    assert.deepEqual([second.isFile(), second.ino, first.nlink], [true, first.ino, 2]);
    await assert.rejects(createLink("a", "b", "folder", "hard"), /only be made to files/);
    await fs.chmod(path.join(root, "a/tool"), 0o4755);
    await assert.rejects(createLink("a/tool", "b", "tool", "hard"), /run as their owner/);
  });
});

test("links stay inside the account's folder, and never to FilesDude's own", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/mine.txt": "m", "home/alice/hers.txt": "h", ".filedude/users.json": "secret" });
    await fs.symlink("../alice", path.join(root, "home/bob/to-alice"));
    await assert.rejects(createLink(".filedude/users.json", "", "users", "symbolic"), /reserved/);
    await runInScope({ accountKey: "bob", username: "bob", role: "editor", root: "home/bob" }, async () => {
      assert.equal((await createLink("home/bob/mine.txt", "home/bob", "mine link.txt", "symbolic")).symlinkTarget, "mine.txt");
      await assert.rejects(createLink("home/alice/hers.txt", "home/bob", "hers", "symbolic"));
      await assert.rejects(createLink("home/alice/hers.txt", "home/bob", "hers", "hard"));
      await assert.rejects(createLink("home/bob/to-alice/hers.txt", "home/bob", "hers", "symbolic"));
      await assert.rejects(createLink("home/bob/mine.txt", "home/alice", "planted", "symbolic"));
    });
    assert.deepEqual((await fs.readdir(path.join(root, "home/alice"))).sort(), ["hers.txt"]);
  });
});

test("a link can be pointed somewhere else, inside the account's folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/old.txt": "old", "home/bob/new/new.txt": "new", "home/alice/hers.txt": "h" });
    await fs.symlink("old.txt", path.join(root, "home/bob/current"));
    await runInScope({ accountKey: "bob", username: "bob", role: "editor", root: "home/bob" }, async () => {
      const entry = await retargetLink("home/bob/current", "home/bob/new/new.txt");
      assert.equal(entry.symlinkTarget, "new/new.txt");
      assert.equal(await fs.readFile(path.join(root, "home/bob/current"), "utf8"), "new");
      await assert.rejects(retargetLink("home/bob/current", "home/alice/hers.txt"));
      await assert.rejects(retargetLink("home/bob/old.txt", "home/bob/new/new.txt"), /Only links/);
      await assert.rejects(retargetLink("home/bob/current", "home/bob/missing.txt"));
    });
    assert.equal(await fs.readlink(path.join(root, "home/bob/current")), "new/new.txt");
    assert.deepEqual((await fs.readdir(path.join(root, "home/bob"))).sort(), ["current", "new", "old.txt"]);
  });
});
