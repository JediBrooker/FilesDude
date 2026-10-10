import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readActivity } from "../lib/activity";
import { activityCategory, activityUser, describeActivity, groupUploads, SHARE_LINK_ACTOR, SYSTEM_ACTOR, visibleText } from "../lib/activity-text";
import { audit, isAuditArchive, MAX_AUDIT_BYTES } from "../lib/audit";
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
    all.push(...page.entries.filter((entry) => !entry.event.startsWith("audit.")).map((entry) => String(entry.n ?? entry.event)));
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
    assert.deepEqual(await readAll({ user: SHARE_LINK_ACTOR }), ["6"]);
    assert.deepEqual(await readAll({ user: SYSTEM_ACTOR }), ["7"]);
    // An account can't be named like FilesDude itself or a share link.
    assert.deepEqual(await readAll({ user: "system" }), []);
    assert.deepEqual(await readAll({ query: "FILM" }), ["5"]);
    assert.deepEqual(await readAll({ query: "10.0.0.9" }), ["8"]);
  });
});

test("the log rotates when it grows large, and reading continues into older files", async () => {
  await withState(async (state) => {
    // A log from an earlier version, with a numbered archive.
    await fs.writeFile(path.join(state, "audit.jsonl.1"), `${JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), event: "fs.create", username: "alice", n: 0 })}\n`);
    await fs.utimes(path.join(state, "audit.jsonl.1"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    for (let n = 1; n <= 30; n += 1) await audit("fs.create", { username: "alice", n });
    // Make the log look full, then write more: the old log becomes a dated archive.
    const current = path.join(state, "audit.jsonl");
    const handle = await fs.open(current, "a");
    await handle.write(`${"x".repeat(1000)}\n`.repeat(Math.ceil(MAX_AUDIT_BYTES / 1001)));
    await handle.close();
    for (let n = 31; n <= 60; n += 1) await audit("fs.create", { username: "alice", n });
    const archives = (await fs.readdir(state)).filter((name) => isAuditArchive(name) && name.startsWith("audit-"));
    assert.equal(archives.length, 1);
    assert.ok((await fs.stat(path.join(state, archives[0]))).size >= MAX_AUDIT_BYTES);
    assert.ok((await fs.stat(current)).size < 10_000);
    // The rotation itself is recorded first in the new file.
    assert.match(await fs.readFile(current, "utf8"), /^\{"at":"[^"]+","event":"audit\.rotated"/);
    assert.deepEqual(await readAll(), Array.from({ length: 61 }, (_, index) => String(60 - index)));
  });
});

test("flooding the log can't push out recent history, and no entry can be large", async () => {
  await withState(async (state) => {
    await audit("fs.delete", { username: "mallory", paths: ["evidence.txt"], permanent: true, n: 1 });
    // Huge or deeply nested details are cut down to a small entry.
    let nested: unknown = true;
    for (let depth = 0; depth < 7_000; depth += 1) nested = [nested];
    await audit("fs.details", { username: "mallory", paths: Array.from({ length: 1_000 }, () => "ࠀ".repeat(4_096)), permanent: nested });
    assert.ok((await fs.stat(path.join(state, "audit.jsonl"))).size < 20_000);
    // Archives younger than 30 days are kept even past 256 MB; older ones go, and only past 1 GB
    // in total are recent ones removed.
    const archive = async (name: string, megabytes: number, daysOld: number) => {
      const location = path.join(state, name);
      const handle = await fs.open(location, "w");
      await handle.truncate(megabytes * 1024 * 1024);
      await handle.close();
      const time = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      await fs.utimes(location, time, time);
    };
    await archive("audit-20260101T000000000Z.jsonl", 100, 1);
    await archive("audit-20260102T000000000Z.jsonl", 100, 2);
    await archive("audit-20260103T000000000Z.jsonl", 100, 3);
    await archive("audit-20250101T000000000Z.jsonl", 100, 40);
    await archive("audit-20250102T000000000Z.jsonl", 8, 41);
    const current = path.join(state, "audit.jsonl");
    const handle = await fs.open(current, "a");
    await handle.write(`${"x".repeat(1000)}\n`.repeat(Math.ceil(MAX_AUDIT_BYTES / 1001)));
    await handle.close();
    await audit("fs.create", { username: "alice", n: 2 });
    const names = await fs.readdir(state);
    for (const kept of ["audit-20260101T000000000Z.jsonl", "audit-20260102T000000000Z.jsonl", "audit-20260103T000000000Z.jsonl"]) assert.ok(names.includes(kept), kept);
    assert.ok(!names.includes("audit-20250101T000000000Z.jsonl") && !names.includes("audit-20250102T000000000Z.jsonl"));
    assert.match(await fs.readFile(current, "utf8"), /"removed":\["audit-20250101T000000000Z.jsonl","audit-20250102T000000000Z.jsonl"\]/);
    await archive("audit-20260104T000000000Z.jsonl", 900, 0.5);
    const again = await fs.open(current, "a");
    await again.write(`${"x".repeat(1000)}\n`.repeat(Math.ceil(MAX_AUDIT_BYTES / 1001)));
    await again.close();
    await audit("fs.create", { username: "alice", n: 3 });
    // Even past 1 GB, recent history is kept (cheap repeatable events are set aside instead).
    const left = await fs.readdir(state);
    for (const kept of ["audit-20260101T000000000Z.jsonl", "audit-20260102T000000000Z.jsonl", "audit-20260103T000000000Z.jsonl", "audit-20260104T000000000Z.jsonl"]) assert.ok(left.includes(kept), kept);
  });
});

test("a flood of writes is counted rather than queued without end", async () => {
  await withState(async () => {
    await Promise.all(Array.from({ length: 2_200 }, (_, n) => audit("fs.download", { username: "mallory", path: `f${n}` })));
    await audit("fs.create", { username: "alice", n: 1 });
    const { entries } = await readActivity({}, null, 5);
    assert.equal(entries[0].n, 1);
    const all = await readActivity({}, null, 3_000);
    const dropped = all.entries.filter((entry) => entry.event === "audit.dropped");
    assert.equal(dropped.length, 1);
    assert.equal((dropped[0].count as number) + all.entries.filter((entry) => entry.event === "fs.download").length, 2_200);
  });
});

test("unreadable and deeply nested lines are skipped without breaking the page", async () => {
  await withState(async (state) => {
    await audit("fs.create", { username: "alice", n: 1 });
    const deep = `{"at":"2026-01-01T00:00:00.000Z","event":"fs.delete","x":${"[".repeat(4_000)}1${"]".repeat(4_000)}}`;
    await fs.appendFile(path.join(state, "audit.jsonl"), `${deep}\n`);
    await audit("fs.create", { username: "alice", n: 2 });
    const { entries } = await readActivity();
    assert.deepEqual(entries.map((entry) => entry.n ?? entry.event), [2, "fs.delete", 1]);
  });
});

test("a page's cursor survives the log rotating before the next page is read", async () => {
  await withState(async (state) => {
    for (let n = 1; n <= 60; n += 1) await audit("fs.create", { username: "alice", n });
    const first = await readActivity({}, null, 25);
    // Rotation happens between the two requests.
    await fs.rename(path.join(state, "audit.jsonl"), path.join(state, "audit-20260101T000000000Z.jsonl"));
    await audit("fs.create", { username: "alice", n: 61 });
    const second = await readActivity({}, first.cursor, 100);
    assert.deepEqual(second.entries.map((entry) => entry.n), Array.from({ length: 35 }, (_, index) => 35 - index));
    assert.equal(second.cursor, null);
    await assert.rejects(readActivity({}, "not-a-cursor"), /Invalid activity cursor/);
    // A cursor for a file that is gone (or a new file reusing its inode) finds nothing.
    const [ino, offset] = first.cursor!.split(".");
    assert.deepEqual(await readActivity({}, `${ino}.${offset}.123`), { entries: [], cursor: null });
  });
});

test("long lists and text are shortened, and malformed lines are skipped", async () => {
  await withState(async (state) => {
    await audit("fs.delete", { username: "alice", paths: Array.from({ length: 500 }, (_, index) => `file ${index}`), note: "y".repeat(5000) });
    await fs.appendFile(path.join(state, "audit.jsonl"), "{not json\n\n{\"event\":5}\n");
    const { entries } = await readActivity();
    assert.equal(entries.length, 1);
    const paths = entries[0].paths as string[];
    assert.equal(paths.length, 26);
    assert.equal(paths[25], "…and 475 more");
    assert.ok((entries[0].note as string).length < 600);
    assert.deepEqual(await readActivity({}, null), { entries, cursor: null });
  });
});

test("each upload shows as one entry with its totals, every file still recorded", () => {
  const at = "2026-10-10T00:00:00.000Z";
  const entries = [
    { at, event: "fs.upload", username: "bob", directory: "Docs/Holiday/day2", files: ["Docs/Holiday/day2/c.jpg"], bytes: 300, batch: "batch-one-1" },
    { at, event: "login.succeeded", username: "alice" },
    { at, event: "fs.upload", username: "bob", directory: "Docs/Holiday/day1", files: ["Docs/Holiday/day1/a.jpg", "Docs/Holiday/day1/b.jpg"], bytes: 700, batch: "batch-one-1" },
    { at, event: "fs.create", username: "bob", path: "Docs", name: "Holiday", upload: true, batch: "batch-one-1" },
    { at, event: "fs.upload", username: "bob", directory: "Other", files: ["Other/x.txt"], bytes: 5 },
  ];
  const grouped = groupUploads(entries);
  assert.deepEqual(grouped.map((entry) => entry.event), ["fs.upload", "login.succeeded", "fs.upload"]);
  assert.equal(describeActivity(grouped[0]).text, "uploaded 3 files (1000 B) to /Docs, making 1 folder");
  assert.equal(describeActivity(grouped[2]).text, "uploaded 1 file (5 B) to /Other");
  // Another account's upload with the same id is kept apart.
  assert.equal(groupUploads([...entries, { at, event: "fs.upload", username: "carol", directory: "C", files: ["C/y"], bytes: 1, batch: "batch-one-1" }]).length, 4);
});

test("events read as plain sentences", () => {
  assert.equal(describeActivity({ event: "fs.move", paths: ["a.txt", "b.txt"], destination: "Media", status: "done" }).text, "moved 2 items to /Media");
  const failed = describeActivity({ event: "fs.copy", paths: ["a.txt"], destination: "Backup", status: "failed", error: "No space" });
  assert.deepEqual([failed.text, failed.tone], ["copied /a.txt to /Backup (failed: No space)", "danger"]);
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
  assert.equal(activityUser({ event: "share.download" }), SHARE_LINK_ACTOR);
  assert.equal(activityUser({ event: "trash.purge" }), SYSTEM_ACTOR);
  // Names and paths are separate parts, so a crafted name can't read as part of the sentence, and
  // invisible or direction-changing characters are shown.
  const spoof = describeActivity({ event: "fs.rename", path: "notes.txt", name: "x” and permanently deleted /Photos “y" });
  assert.deepEqual(spoof.parts, ["renamed ", { value: "/notes.txt" }, " to ", { value: "x” and permanently deleted /Photos “y" }]);
  assert.equal(visibleText("evil\u202etxt.exe"), "evil⟨U+202E⟩txt.exe");
  assert.equal(visibleText("plain name.txt"), "plain name.txt");
});
