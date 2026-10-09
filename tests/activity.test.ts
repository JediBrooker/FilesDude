import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readActivity } from "../lib/activity";
import { activityCategory, activityUser, describeActivity } from "../lib/activity-text";
import { audit, MAX_AUDIT_BYTES } from "../lib/audit";
import { config } from "../lib/config";

async function withState<T>(run: (state: string) => Promise<T>) {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-activity-")));
  const original = config.stateDir;
  config.stateDir = state;
  try {
    return await run(state);
  } finally {
    config.stateDir = original;
    await fs.rm(state, { recursive: true, force: true });
  }
}

// Reads every page, checking each continues exactly where the last stopped.
async function readAll(filter: Parameters<typeof readActivity>[0] = {}) {
  const all: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await readActivity(filter, cursor, 40);
    all.push(...page.entries.map((entry) => String(entry.n ?? entry.event)));
    cursor = page.cursor;
    pages += 1;
  } while (cursor && pages < 100);
  return all;
}

test("activity reads newest first, page by page, with nothing missed or repeated", async () => {
  await withState(async () => {
    for (let n = 1; n <= 130; n += 1) await audit("fs.create", { username: n % 2 ? "alice" : "bob", path: `folder ${n}`, n });
    const first = await readActivity({}, null, 40);
    assert.deepEqual(first.entries.slice(0, 3).map((entry) => entry.n), [130, 129, 128]);
    assert.ok(first.cursor);
    const all = await readAll();
    assert.deepEqual(all, Array.from({ length: 130 }, (_, index) => String(130 - index)));
  });
});

test("filters pick by kind, account, and text, and reads that change nothing are left out", async () => {
  await withState(async () => {
    await audit("login.succeeded", { username: "alice", client: "192.168.0.50", n: 1 });
    await audit("fs.details", { username: "alice", path: "secret.txt", n: 2 });
    await audit("fs.bulkRename", { username: "alice", paths: ["a"], apply: false, n: 3 });
    await audit("fs.bulkRename", { username: "alice", paths: ["a"], apply: true, n: 4 });
    await audit("fs.download", { username: "bob", path: "Media/film.mkv", n: 5 });
    await audit("share.download", { id: "x", path: "Docs/report.pdf", address: "203.0.113.9", n: 6 });
    await audit("trash.purge", { removed: 3, n: 7 });
    await audit("login.failed", { username: "mallory", client: "10.0.0.9", n: 8 });
    assert.deepEqual(await readAll(), ["8", "7", "6", "5", "4", "1"]);
    assert.deepEqual(await readAll({ category: "downloads" }), ["6", "5"]);
    assert.deepEqual(await readAll({ category: "sign-ins" }), ["8", "1"]);
    assert.deepEqual(await readAll({ user: "Alice" }), ["4", "1"]);
    assert.deepEqual(await readAll({ user: "share link" }), ["6"]);
    assert.deepEqual(await readAll({ user: "system" }), ["7"]);
    assert.deepEqual(await readAll({ query: "FILM" }), ["5"]);
    assert.deepEqual(await readAll({ query: "10.0.0.9" }), ["8"]);
  });
});

test("the log rotates when it grows large, and reading continues into older files", async () => {
  await withState(async (state) => {
    for (let n = 1; n <= 30; n += 1) await audit("fs.create", { username: "alice", n });
    // Make the log look full, then write more: the old log becomes audit.jsonl.1.
    const current = path.join(state, "audit.jsonl");
    const handle = await fs.open(current, "a");
    await handle.write(`${"x".repeat(1000)}\n`.repeat(Math.ceil(MAX_AUDIT_BYTES / 1001)));
    await handle.close();
    for (let n = 31; n <= 60; n += 1) await audit("fs.create", { username: "alice", n });
    assert.ok((await fs.stat(path.join(state, "audit.jsonl.1"))).size >= MAX_AUDIT_BYTES);
    assert.ok((await fs.stat(current)).size < 10_000);
    // Junk lines are skipped, and the 4 MB-per-request limit just means more pages.
    assert.deepEqual(await readAll(), Array.from({ length: 60 }, (_, index) => String(60 - index)));
  });
});

test("a page's cursor survives the log rotating before the next page is read", async () => {
  await withState(async (state) => {
    for (let n = 1; n <= 60; n += 1) await audit("fs.create", { username: "alice", n });
    const first = await readActivity({}, null, 25);
    // Rotation happens between the two requests.
    await fs.rename(path.join(state, "audit.jsonl"), path.join(state, "audit.jsonl.1"));
    await audit("fs.create", { username: "alice", n: 61 });
    const second = await readActivity({}, first.cursor, 100);
    assert.deepEqual(second.entries.map((entry) => entry.n), Array.from({ length: 35 }, (_, index) => 35 - index));
    assert.equal(second.cursor, null);
    await assert.rejects(readActivity({}, "not-a-cursor"), /Invalid activity cursor/);
  });
});

test("long lists and text are shortened, and malformed lines are skipped", async () => {
  await withState(async (state) => {
    await audit("fs.delete", { username: "alice", paths: Array.from({ length: 500 }, (_, index) => `file ${index}`), note: "y".repeat(5000) });
    await fs.appendFile(path.join(state, "audit.jsonl"), "{not json\n\n{\"event\":5}\n");
    const { entries } = await readActivity();
    assert.equal(entries.length, 1);
    const paths = entries[0].paths as string[];
    assert.equal(paths.length, 21);
    assert.equal(paths[20], "…and 480 more");
    assert.ok((entries[0].note as string).length < 400);
    assert.deepEqual(await readActivity({}, null), { entries, cursor: null });
  });
});

test("events read as plain sentences", () => {
  assert.equal(describeActivity({ event: "fs.move", paths: ["a.txt", "b.txt"], destination: "Media", status: "done" }).text, "moved 2 items to /Media");
  assert.deepEqual(describeActivity({ event: "fs.copy", paths: ["a.txt"], destination: "Backup", status: "failed", error: "No space" }), { text: "copied /a.txt to /Backup (failed: No space)", detail: undefined, tone: "danger" });
  assert.equal(describeActivity({ event: "fs.upload", directory: "Photos", files: ["a", "b", "c"], bytes: 5 * 1024 * 1024 }).text, "uploaded 3 files (5.0 MB) to /Photos");
  assert.equal(describeActivity({ event: "fs.download", items: 3, paths: ["a", "b", "c"] }).text, "downloaded 3 items as a ZIP");
  assert.equal(describeActivity({ event: "fs.create", path: "Docs", name: "plan.txt" }).text, "created /Docs/plan.txt");
  assert.equal(describeActivity({ event: "fs.chmod", paths: ["a"], mode: "750" }).text, "changed permissions of /a to 750");
  assert.equal(describeActivity({ event: "login.failed", username: "mallory" }).tone, "danger");
  assert.equal(describeActivity({ event: "something.new" }).text, "something.new");
  // Every event FilesDude records has its own wording.
  const events = ["login.succeeded", "login.failed", "login.two_factor.challenged", "login.two_factor.failed", "logout", "fs.upload", "fs.download", "fs.create", "fs.rename", "fs.write", "fs.delete", "fs.copy", "fs.move", "fs.chmod", "fs.chown", "fs.bulkRename", "fs.compress", "fs.extract", "trash.restore", "trash.delete", "trash.empty", "trash.purge", "duplicates.scan", "duplicates.trash", "duplicates.link", "share.create", "share.revoke", "share.download", "users.create", "users.update", "users.delete", "users.two_factor_reset", "settings.password.changed", "settings.credentials.failed", "settings.preferences.updated", "settings.two_factor.enabled", "settings.two_factor.disabled", "settings.two_factor.recovery_codes", "settings.two_factor.failed", "snapshots.create", "snapshots.delete", "snapshots.prune", "snapshots.restore", "snapshots.download", "snapshots.schedule", "snapshots.access"];
  for (const event of events) assert.notEqual(describeActivity({ event }).text, event, event);
  assert.equal(activityCategory("share.download"), "downloads");
  assert.equal(activityCategory("users.create"), "accounts");
  assert.equal(activityUser({ event: "share.download" }), "share link");
  assert.equal(activityUser({ event: "trash.purge" }), "system");
});
