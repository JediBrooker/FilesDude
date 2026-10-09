import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { restoreFromSnapshot } from "../lib/files";
import { getPreferences, savePreferences } from "../lib/preferences";
import { runInScope } from "../lib/scope";
import { runSnapshotSchedule } from "../lib/snapshot-schedule";
import { createSnapshot, deleteSnapshot, itemVersions, listSnapshotFolder, listSnapshots, setZfsRunner, snapshotItem, snapshotSupport } from "../lib/snapshots";

type FakeSnapshot = { name: string; creation: number };

// A temporary root standing in for a ZFS dataset: a fake zfs command, and snapshot contents laid out
// under <root>/.zfs/snapshot/<name>/ the way ZFS exposes them.
async function withFakeZfs<T>(run: (context: { root: string; snapshots: FakeSnapshot[]; commands: string[][]; snap: (name: string, files: Record<string, string>, creation: number) => Promise<void> }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-snapshots-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  const snapshots: FakeSnapshot[] = [];
  const commands: string[][] = [];
  setZfsRunner(async (args) => {
    commands.push(args);
    if (args[0] === "list" && args.includes("filesystem")) return `pool\t/nonexistent-pool\npool/ct100\t${root}\n`;
    if (args[0] === "list" && args.includes("snapshot")) return snapshots.map((item) => `pool/ct100@${item.name}\t${item.creation}\t4096`).join("\n");
    if (args[0] === "snapshot") snapshots.push({ name: args[1].split("@")[1], creation: Math.floor(Date.now() / 1000) });
    if (args[0] === "destroy") snapshots.splice(snapshots.findIndex((item) => `pool/ct100@${item.name}` === args[1]), 1);
    return "";
  });
  const snap = async (name: string, files: Record<string, string>, creation: number) => {
    const folder = path.join(root, ".zfs", "snapshot", name);
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
      if (content.startsWith("link:")) await fs.symlink(content.slice(5), path.join(folder, file));
      else await fs.writeFile(path.join(folder, file), content);
    }
    snapshots.push({ name, creation });
    snapshots.sort((a, b) => a.creation - b.creation);
    await listSnapshots(true);
  };
  try {
    return await run({ root, snapshots, commands, snap });
  } finally {
    setZfsRunner(undefined as never);
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const editor = { accountKey: "bob", username: "bob", role: "editor" as const, root: "home/bob" };

test("snapshots are unavailable when the root isn't on ZFS", async () => {
  setZfsRunner(null);
  try {
    assert.deepEqual(await snapshotSupport(), { available: false });
    await assert.rejects(listSnapshots(true), /ZFS/);
  } finally {
    setZfsRunner(undefined as never);
  }
});

test("snapshots are listed newest first, and only FilesDude's own can be deleted", async () => {
  await withFakeZfs(async ({ snap, commands }) => {
    await snap("autosnap-proxmox", {}, 1_000);
    await snap("filesdude-manual-20260101-000000", {}, 2_000);
    assert.deepEqual(await snapshotSupport(), { available: true, dataset: "pool/ct100" });
    const listed = await listSnapshots(true);
    assert.deepEqual(listed.map((item) => [item.name, item.kind]), [["filesdude-manual-20260101-000000", "manual"], ["autosnap-proxmox", "other"]]);
    await assert.rejects(deleteSnapshot("autosnap-proxmox"), /only deletes snapshots it made/);
    await assert.rejects(deleteSnapshot("missing"), /no longer exists/);
    await deleteSnapshot("filesdude-manual-20260101-000000");
    assert.deepEqual(commands.filter((args) => args[0] === "destroy"), [["destroy", "pool/ct100@filesdude-manual-20260101-000000"]]);

    const at = new Date(Date.UTC(2026, 9, 9, 4, 5, 6));
    assert.equal((await createSnapshot("manual", at)).name, "filesdude-manual-20261009-040506");
    assert.equal((await createSnapshot("manual", at)).name, "filesdude-manual-20261009-040506-2");
  });
});

test("items in snapshots stay inside the account's folder and never go through links", async () => {
  await withFakeZfs(async ({ snap }) => {
    await snap("s1", { "home/bob/notes.txt": "bob", "home/alice/diary.txt": "alice", "home/bob/sneaky": "link:../alice", ".filedude/credentials.json": "{}" }, 1_000);
    await runInScope(editor, async () => {
      assert.equal((await snapshotItem("s1", "home/bob/notes.txt")).stat.size, 3);
      await assert.rejects(snapshotItem("s1", "home/alice/diary.txt"), /outside your folder/);
      await assert.rejects(snapshotItem("s1", "home/bob/../alice/diary.txt"), /outside your folder/);
      await assert.rejects(snapshotItem("s1", "home/bob/sneaky/diary.txt"), /link/);
      await assert.rejects(snapshotItem("s1", ""), /outside your folder/);
      const listing = await listSnapshotFolder("s1", "home/bob");
      assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.type]), [["notes.txt", "file"], ["sneaky", "symlink"]]);
    });
    await assert.rejects(snapshotItem("s1", ".filedude/credentials.json"), /reserved/);
    // A state folder inside the root under another name is just as private.
    const stateDir = config.stateDir;
    config.stateDir = path.join(config.root, "var", "filesdude");
    try {
      await assert.rejects(snapshotItem("s1", "var/filesdude/users.json"), /reserved/);
    } finally {
      config.stateDir = stateDir;
    }
    await assert.rejects(snapshotItem("nope", "home"), /no longer exists/);
  });
});

test("folders download from snapshots as ZIPs for accounts confined to a folder", async () => {
  await withFakeZfs(async ({ snap }) => {
    await snap("s1", { "home/bob/project/a.txt": "a", "home/bob/project/sub/b.txt": "b" }, 1_000);
    const { appendDirectory, reservedPathCheck } = await import("../lib/archives");
    const { snapshotHandleVerifier } = await import("../lib/snapshots");
    const { ZipArchive } = await import("archiver");
    const { constants } = await import("node:fs");
    await runInScope(editor, async () => {
      const item = await snapshotItem("s1", "home/bob/project");
      const handle = await fs.open(item.location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const archive = new ZipArchive();
      const names: string[] = [];
      archive.on("entry", (entry) => names.push(entry.name));
      archive.resume();
      await appendDirectory(archive, handle, item.location, "project", await reservedPathCheck(), undefined, true, snapshotHandleVerifier(item.location));
      await archive.finalize();
      assert.deepEqual(names.sort(), ["project/a.txt", "project/sub/", "project/sub/b.txt"]);
    });
  });
});

test("previous versions list each distinct version once, leaving out the current one", async () => {
  await withFakeZfs(async ({ root, snap }) => {
    const old = new Date("2026-01-01T00:00:00Z");
    await snap("s1", { "docs/a.txt": "version one" }, 1_000);
    await fs.utimes(path.join(root, ".zfs/snapshot/s1/docs/a.txt"), old, old);
    await snap("s2", { "docs/a.txt": "version two!" }, 2_000);
    await snap("s3", { "docs/a.txt": "version two!" }, 3_000);
    await fs.utimes(path.join(root, ".zfs/snapshot/s3/docs/a.txt"), (await fs.stat(path.join(root, ".zfs/snapshot/s2/docs/a.txt"))).mtime, (await fs.stat(path.join(root, ".zfs/snapshot/s2/docs/a.txt"))).mtime);
    await snap("s4", {}, 4_000);
    const versions = await itemVersions("docs/a.txt", { size: 7, modified: new Date().toISOString() });
    assert.deepEqual(versions.map((version) => [version.snapshot, version.size]), [["s3", 12], ["s1", 11]]);
    const s3 = await fs.stat(path.join(root, ".zfs/snapshot/s3/docs/a.txt"));
    const unchanged = await itemVersions("docs/a.txt", { size: 12, modified: s3.mtime.toISOString() });
    assert.deepEqual(unchanged.map((version) => version.snapshot), ["s1"]);
  });
});

test("restoring copies an item out of a snapshot without replacing anything", async () => {
  await withFakeZfs(async ({ root, snap }) => {
    await snap("s1", { "home/bob/project/readme.md": "old readme", "home/bob/project/src/main.ts": "old main", "home/bob/report.txt": "old report" }, Date.parse("2026-10-01T09:30:00Z") / 1000);
    await fs.mkdir(path.join(root, "home/bob"), { recursive: true });
    await fs.writeFile(path.join(root, "home/bob/report.txt"), "current report");
    await runInScope(editor, async () => {
      // A folder with nested folders, for an account confined to home/bob.
      const folder = await snapshotItem("s1", "home/bob/project");
      const restored = await restoreFromSnapshot(folder.folder, folder.name, "home/bob", "restored 2026-10-01 19.30");
      assert.deepEqual(restored, { source: "project", path: "home/bob/project", renamed: false });
      assert.equal(await fs.readFile(path.join(root, "home/bob/project/src/main.ts"), "utf8"), "old main");

      // A file whose name is taken comes back beside the current one.
      const file = await snapshotItem("s1", "home/bob/report.txt");
      const beside = await restoreFromSnapshot(file.folder, file.name, "home/bob", "restored 2026-10-01 19.30");
      assert.deepEqual(beside, { source: "report.txt", path: "home/bob/report (restored 2026-10-01 19.30).txt", renamed: true });
      assert.equal(await fs.readFile(path.join(root, "home/bob/report.txt"), "utf8"), "current report");
      assert.equal(await fs.readFile(path.join(root, "home/bob/report (restored 2026-10-01 19.30).txt"), "utf8"), "old report");

      // A folder that no longer exists is recreated; one outside the account's folder is refused.
      await fs.rm(path.join(root, "home/bob/project"), { recursive: true });
      const nested = await snapshotItem("s1", "home/bob/project/src/main.ts");
      assert.equal((await restoreFromSnapshot(nested.folder, nested.name, "home/bob/project/src", "restored")).path, "home/bob/project/src/main.ts");
      await assert.rejects(restoreFromSnapshot(nested.folder, nested.name, "home/alice", "restored"), /outside your folder/);
    });
  });
});

test("the schedule takes snapshots when due and keeps only the newest automatic ones", async () => {
  await withFakeZfs(async ({ snapshots, snap }) => {
    await snap("filesdude-manual-20260101-000000", {}, 1_000);
    assert.deepEqual(await runSnapshotSchedule(), { created: null, deleted: [] });
    await savePreferences({ ...(await getPreferences()), snapshotSchedule: { frequency: "hourly", keep: 2 } });
    const hour = 60 * 60_000;
    const start = Date.parse("2026-10-09T00:00:00Z");
    const run = async (at: number) => {
      const result = await runSnapshotSchedule(at);
      // The fake records creation as now; give it the scheduled time instead.
      if (result.created) snapshots.find((item) => item.name === result.created!.name)!.creation = Math.floor(at / 1000);
      await listSnapshots(true);
      return result;
    };
    assert.ok((await run(start)).created);
    assert.equal((await run(start + 10 * 60_000)).created, null);
    assert.ok((await run(start + hour - 60_000)).created, "due slightly early so checks don't drift");
    const third = await run(start + 2 * hour);
    assert.ok(third.created);
    assert.equal(third.deleted.length, 1);
    const names = (await listSnapshots(true)).map((item) => item.name);
    assert.equal(names.filter((name) => name.startsWith("filesdude-auto-")).length, 2);
    assert.ok(names.includes("filesdude-manual-20260101-000000"), "manual snapshots are never pruned");
  });
});
