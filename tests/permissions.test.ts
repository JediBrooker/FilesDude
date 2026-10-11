import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { changeAccess } from "../lib/files";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-access-")));
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

const modeOf = async (location: string) => ((await fs.lstat(location)).mode & 0o7777).toString(8);
const modes = { fileMode: 0o644, folderMode: 0o755, uid: null, gid: null };

test("files and folders get their own modes, everything inside too, and a preview changes nothing", async () => {
  await withRoot(async (root) => {
    await write(root, { "site/index.html": "i", "site/css/a.css": "a", "site/css/deep/b.css": "b" });
    for (const item of ["site", "site/css", "site/css/deep"]) await fs.chmod(path.join(root, item), 0o700);
    for (const item of ["site/index.html", "site/css/a.css", "site/css/deep/b.css"]) await fs.chmod(path.join(root, item), 0o600);
    const preview = await changeAccess(["site"], { ...modes, recursive: true }, { apply: false });
    assert.deepEqual([preview.files, preview.folders, preview.changing, preview.changed], [3, 3, 6, 0]);
    assert.equal(await modeOf(path.join(root, "site/css/a.css")), "600");
    const applied = await changeAccess(["site"], { ...modes, recursive: true }, { apply: true });
    assert.equal(applied.changed, 6);
    assert.deepEqual(await Promise.all(["site", "site/css/deep", "site/index.html", "site/css/deep/b.css"].map((item) => modeOf(path.join(root, item)))), ["755", "755", "644", "644"]);
    // Done again, nothing needs changing.
    assert.equal((await changeAccess(["site"], { ...modes, recursive: true }, { apply: false })).changing, 0);
    // Without recursive, only the folder itself.
    await fs.chmod(path.join(root, "site"), 0o700);
    await fs.chmod(path.join(root, "site/index.html"), 0o600);
    await changeAccess(["site"], { ...modes, recursive: false }, { apply: true });
    assert.deepEqual([await modeOf(path.join(root, "site")), await modeOf(path.join(root, "site/index.html"))], ["755", "600"]);
  });
});

test("links aren't followed, special files and FilesDude's own folders are left alone, and setuid is never set", async () => {
  await withRoot(async (root) => {
    await write(root, { "outside/secret.txt": "s", "tree/tool": "#!/bin/sh", ".filedude/trash/x": "t" });
    await fs.chmod(path.join(root, "outside/secret.txt"), 0o600);
    await fs.chmod(path.join(root, ".filedude/trash/x"), 0o600);
    await fs.symlink("../outside/secret.txt", path.join(root, "tree/link"));
    await fs.symlink("../.filedude", path.join(root, "tree/internal"));
    execFileSync("mkfifo", [path.join(root, "tree/pipe")]);
    await fs.chmod(path.join(root, "tree/tool"), 0o4755);
    const report = await changeAccess(["tree"], { fileMode: 0o4777, folderMode: 0o755, uid: null, gid: null, recursive: true }, { apply: true });
    assert.equal(report.skipped, 3);
    assert.equal(await modeOf(path.join(root, "outside/secret.txt")), "600");
    assert.equal(await modeOf(path.join(root, ".filedude/trash/x")), "600");
    assert.equal(await modeOf(path.join(root, "tree/tool")), "777");
    await assert.rejects(changeAccess([".filedude"], { ...modes, recursive: true }, { apply: true }), /reserved/);
    await assert.rejects(changeAccess([""], { ...modes, recursive: true }, { apply: true }));
    assert.equal(await modeOf(path.join(root, ".filedude/trash/x")), "600");
  });
});

test("counting stops at its limits and says so, and bad values are refused", async () => {
  await withRoot(async (root) => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) files[`many/f${index}`] = "x";
    await write(root, files);
    const short = await changeAccess(["many"], { ...modes, recursive: true }, { apply: false, limits: { entries: 5, milliseconds: 60_000 } });
    assert.deepEqual([short.complete, short.reason], [false, "limit"]);
    await assert.rejects(changeAccess(["many"], { ...modes, fileMode: 0o17777, recursive: false }, { apply: false }), /octal/);
    await assert.rejects(changeAccess(["many"], { ...modes, fileMode: 1.5, recursive: false }, { apply: false }), /octal/);
    await assert.rejects(changeAccess(["many"], { ...modes, uid: -1, recursive: false }, { apply: false }), /numeric/);
    await assert.rejects(changeAccess(["../outside"], { ...modes, recursive: false }, { apply: false }));
  });
});

test("ownership changes reach everything inside too", { skip: process.getuid?.() !== 0 && "needs root" }, async () => {
  await withRoot(async (root) => {
    await write(root, { "share/a.txt": "a", "share/sub/b.txt": "b" });
    const report = await changeAccess(["share"], { fileMode: null, folderMode: null, uid: 100000, gid: 100000, recursive: true }, { apply: true });
    assert.equal(report.changed, 4);
    for (const item of ["share", "share/sub", "share/sub/b.txt"]) {
      const stat = await fs.lstat(path.join(root, item));
      assert.deepEqual([stat.uid, stat.gid], [100000, 100000], item);
    }
  });
});
