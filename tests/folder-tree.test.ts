import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { listFolders } from "../lib/files";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-tree-")));
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

test("the folder tree lists only real folders, in name order, without FilesDude's own or hidden ones", async () => {
  await withRoot(async (root) => {
    for (const folder of ["Season 10", "Season 2", "alpha", ".hidden", ".filedude", "home/bob/inner", "home/alice"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, "file.txt"), "x");
    await fs.symlink("alpha", path.join(root, "link-to-alpha"));
    const top = await listFolders("");
    assert.deepEqual(top.folders.map((folder) => folder.name), ["alpha", "home", "Season 2", "Season 10"]);
    assert.equal(top.truncated, false);
    assert.deepEqual((await listFolders("", true)).folders.map((folder) => folder.name), [".hidden", "alpha", "home", "Season 2", "Season 10"]);
    assert.deepEqual((await listFolders("home/")).folders, [{ name: "alice", path: "home/alice" }, { name: "bob", path: "home/bob" }]);
    await assert.rejects(listFolders("file.txt"));
    await assert.rejects(listFolders("missing"));
    await assert.rejects(listFolders("../"));
    // An account sees only folders inside its own.
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.deepEqual((await listFolders("home/bob")).folders.map((folder) => folder.path), ["home/bob/inner"]);
      await assert.rejects(listFolders("home/alice"), /outside your folder/);
      await assert.rejects(listFolders(""), /outside your folder/);
    });
  });
});
