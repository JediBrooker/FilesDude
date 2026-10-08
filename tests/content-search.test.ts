import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { searchContents } from "../lib/content-search";

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

const within = <T,>(promise: Promise<T>, ms = 3_000) => Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`did not finish within ${ms}ms`)), ms))]);

test("finds text in nested files with line numbers, case-insensitively by default", async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, "docs", "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# Plan\r\nShip the Backup job\nnothing here\nbackup again\n");
    await fs.writeFile(path.join(root, "docs", "notes", "todo.txt"), "BACKUP the database");
    await fs.writeFile(path.join(root, "other.txt"), "unrelated");
    const result = await searchContents("", "backup");
    assert.deepEqual(result.hits.map((hit) => [hit.path, hit.matchCount, hit.matches.map((match) => match.line)]), [
      ["docs/notes/todo.txt", 1, [1]],
      ["docs/plan.md", 2, [2, 4]],
    ]);
    assert.equal(result.hits[1].matches[0].text, "Ship the Backup job");
    assert.equal(result.scannedFiles, 3);
    assert.equal(result.stoppedBy, null);

    const exact = await searchContents("docs", "Backup", { caseSensitive: true });
    assert.deepEqual(exact.hits.map((hit) => hit.path), ["docs/plan.md"]);
    assert.equal(exact.hits[0].matchCount, 1);
  });
});

test("long lines are trimmed around the match", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "log.txt"), `${"a".repeat(5000)}NEEDLE${"b".repeat(5000)}`);
    const [hit] = (await searchContents("", "needle")).hits;
    assert.ok(hit.matches[0].text.length <= 202);
    assert.match(hit.matches[0].text, /^…a+NEEDLEb+…$/);
  });
});

test("binary, oversized, linked, hidden, and internal files are left out", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.concat([Buffer.from("secret"), Buffer.from([0, 1, 2])]));
    await fs.writeFile(path.join(root, "photo.jpg"), "secret in a jpeg name");
    await fs.writeFile(path.join(root, "big.txt"), `secret${"x".repeat(5 * 1024 * 1024)}`);
    await fs.writeFile(path.join(path.dirname(root), "outside.txt"), "secret outside the root");
    await fs.symlink("../outside.txt", path.join(root, "link.txt"));
    await fs.symlink(path.dirname(root), path.join(root, "linked-folder"));
    await fs.writeFile(path.join(root, ".hidden.txt"), "secret hidden");
    await fs.mkdir(path.join(root, ".filedude"));
    await fs.writeFile(path.join(root, ".filedude", "state.json"), "secret state");
    await fs.writeFile(path.join(root, "plain.txt"), "a secret in plain text");

    const result = await searchContents("", "secret");
    assert.deepEqual(result.hits.map((hit) => hit.path), ["plain.txt"]);
    assert.ok(result.skippedFiles >= 3);
    const withHidden = await searchContents("", "secret", { showHidden: true });
    assert.deepEqual(withHidden.hits.map((hit) => hit.path), [".hidden.txt", "plain.txt"]);
    await assert.rejects(searchContents(".filedude", "secret"), /reserved/);
  });
});

test("a named pipe in the tree does not block the search", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    execFileSync("mkfifo", [path.join(root, "pipe.txt")]);
    await fs.writeFile(path.join(root, "real.txt"), "findme");
    const result = await within(searchContents("", "findme"));
    assert.deepEqual(result.hits.map((hit) => hit.path), ["real.txt"]);
  });
});

test("searches stop at their limits and say why", async () => {
  await withRoot(async (root) => {
    for (let index = 0; index < 6; index += 1) await fs.writeFile(path.join(root, `f${index}.txt`), "match here");
    assert.equal((await searchContents("", "match", { limits: { maxHits: 2 } })).stoppedBy, "results");
    assert.equal((await searchContents("", "match", { limits: { maxFiles: 3 } })).stoppedBy, "files");
    assert.equal((await searchContents("", "match", { limits: { maxBytes: 25 } })).stoppedBy, "bytes");
    assert.equal((await searchContents("", "match", { limits: { maxMs: -1 } })).stoppedBy, "time");
    const capped = await searchContents("", "match", { limits: { maxHits: 2 } });
    assert.equal(capped.hits.length, 2);
  });
});

test("queries are validated and searches can be cancelled", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "text");
    await assert.rejects(searchContents("", "a"), /2 to 200 characters/);
    await assert.rejects(searchContents("", "x".repeat(201)), /2 to 200 characters/);
    await assert.rejects(searchContents("a.txt", "text"), /Choose a folder/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchContents("", "text", { signal: controller.signal }), /cancelled/);
  });
});
