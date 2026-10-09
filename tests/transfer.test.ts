import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { execFileSync } from "node:child_process";
import { acquireFilesystemLock, copyOrMove, deleteEntries, listTrash, purgeExpiredTrash, recoverInterruptedCopies, PartialTransferError, renameEntry, restoreTrashItems, withFilesystemLock } from "../lib/files";
import { listJobs, startJob } from "../lib/jobs";
import { currentScope, runInScope, runUnscoped } from "../lib/scope";
import { getPreferences, savePreferences } from "../lib/preferences";
import { runTrashRetention } from "../lib/trash-retention";
import { readCopyJournal, recordCopy } from "../lib/copy-journal";
import { createShare, openSharedItem, resolveShareToken, rewriteSharePaths } from "../lib/shares";
import type { JobProgress } from "../lib/types";

const MB = 1024 * 1024;

async function withTempRoot<T>(run: (root: string) => Promise<T>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-transfer-")));
  const original = { root: config.root, trashEnabled: config.trashEnabled, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled };
  Object.assign(config, { root, trashEnabled: true, stateDir: path.join(root, ".filedude"), sessionSecret: "transfer-test-session-secret-with-more-than-32-characters", sharingEnabled: true });
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

test("renaming a symlink to its target's name refuses instead of overwriting the target", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "precious");
    await fs.symlink("a.txt", path.join(root, "link"));
    await assert.rejects(renameEntry("link", "a.txt"), /already exists/);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "precious");
    assert.ok((await fs.lstat(path.join(root, "link"))).isSymbolicLink());

    await fs.symlink("missing-target", path.join(root, "dangling"));
    await fs.writeFile(path.join(root, "b.txt"), "b");
    await assert.rejects(renameEntry("b.txt", "dangling"), /already exists/);
    assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "b");

    await fs.writeFile(path.join(root, "Readme.txt"), "r");
    assert.equal((await renameEntry("Readme.txt", "README.txt")).name, "README.txt");
    assert.equal(await fs.readFile(path.join(root, "README.txt"), "utf8"), "r");
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

test("copies report byte progress and don't hold the filesystem lock while copying", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "big"));
    await fs.writeFile(path.join(root, "big", "a.bin"), Buffer.alloc(12 * MB, 1));
    await fs.writeFile(path.join(root, "big", "b.bin"), Buffer.alloc(4 * MB, 2));
    await fs.mkdir(path.join(root, "dest"));
    const reports: JobProgress[] = [];
    let lockedAt: number | null = null;
    let lockRequested = false;
    const copied = await copyOrMove(["big"], "dest", false, {
      report: (progress) => {
        reports.push(progress);
        if (progress.done > 0 && !lockRequested) {
          lockRequested = true;
          void withFilesystemLock(async () => { lockedAt = reports.at(-1)!.done; });
        }
      },
    });
    assert.deepEqual(copied, [{ source: "big", path: "dest/big", renamed: false }]);
    assert.equal(reports[0].total, 16 * MB);
    assert.equal(reports.at(-1)!.done, 16 * MB);
    // Other work got the lock while the copy was still writing.
    assert.ok(lockedAt !== null && lockedAt < 16 * MB, `lock taken at ${lockedAt}`);
    assert.equal((await fs.stat(path.join(root, "dest", "big", "a.bin"))).size, 12 * MB);
    assert.deepEqual((await fs.readdir(path.join(root, "dest"))).sort(), ["big"]);
  });
});

test("a move between filesystems removes only what it copied and leaves anything new in place", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.txt"), "a");
    await fs.mkdir(path.join(root, "dest"));
    const original = { rename: fs.rename, link: fs.link, readdir: fs.readdir };
    let injected = false;
    // Pretend dest is another filesystem, and have a file arrive in the original once the copy has
    // listed it, as a process already working inside the folder could.
    const crossDevice = (target: unknown) => {
      if (String(target).includes(`${path.sep}dest`) || /\/proc\/self\/fd\/\d+\/src$/.test(String(target))) {
        return Promise.reject(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
      }
      return null;
    };
    Object.assign(fs, {
      rename: (from: string, to: string) => (String(from).endsWith("/src") ? crossDevice(to) ?? original.rename(from, to) : original.rename(from, to)),
      link: (from: string, to: string) => crossDevice(to) ?? original.link(from, to),
      readdir: async (...args: Parameters<typeof fs.readdir>) => {
        const result = await (original.readdir as (...a: unknown[]) => Promise<unknown>)(...args);
        if (!injected && Array.isArray(result) && result.includes("a.txt")) {
          injected = true;
          await fs.writeFile(path.join(root, "src", "late.txt"), "late");
        }
        return result;
      },
    });
    const folderShare = await createShare("src", 1, null);
    const fileShare = await createShare("src/a.txt", 1, null);
    try {
      const moved = await copyOrMove(["src"], "dest", true, {
        moved: async (item, copies) => { await rewriteSharePaths([{ from: item.source, to: item.path }], copies); },
      });
      assert.deepEqual(moved, [{ source: "src", path: "dest/src", renamed: false, leftBehind: true }]);
    } finally {
      Object.assign(fs, original);
    }
    // Links follow the copies, which have new identities, and still open.
    for (const [share, expected] of [[folderShare, "dest/src"], [fileShare, "dest/src/a.txt"]] as const) {
      const resolved = await resolveShareToken(share.url.replace(/^\/s\//, ""));
      assert.equal(resolved?.path, expected);
      const opened = await openSharedItem(resolved!);
      assert.ok(opened, `${expected} opens`);
      await opened.handle.close();
    }
    assert.ok(injected);
    assert.deepEqual(await fs.readdir(path.join(root, "dest", "src")), ["a.txt"]);
    assert.deepEqual(await fs.readdir(path.join(root, "src")), ["late.txt"]);
    assert.deepEqual(await fs.readdir(path.join(root, "dest")), ["src"]);
  });
});

test("a copy cancelled while waiting to be put in place is removed", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "file.bin"), Buffer.alloc(2 * MB));
    const controller = new AbortController();
    let held = false;
    await assert.rejects(copyOrMove(["file.bin"], "dest", false, {
      signal: controller.signal,
      report: (progress) => {
        // Take the lock as the copy finishes, cancel while the job waits for it, then let it go.
        if (progress.total && progress.done >= progress.total && !held) {
          held = true;
          void acquireFilesystemLock().then((release) => {
            controller.abort();
            setTimeout(release, 20);
          });
        }
      },
    }), /cancelled/);
    assert.deepEqual(await fs.readdir(path.join(root, "dest")), []);
  });
});

test("copies of items with names near the length limit still get a placeholder that fits", async () => {
  await withTempRoot(async (root) => {
    const name = `${"é".repeat(124)}x.txt`;
    assert.equal(Buffer.byteLength(name), 253);
    await fs.writeFile(path.join(root, name), "long");
    await fs.mkdir(path.join(root, "dest"));
    assert.deepEqual(await copyOrMove([name], "dest", false), [{ source: name, path: `dest/${name}`, renamed: false }]);
    const second = await copyOrMove([name], "dest", false);
    assert.ok(Buffer.byteLength(path.posix.basename(second[0].path)) <= 255 && second[0].renamed);
  });
});

test("copies are journaled while they run, and placeholders left by a restart are cleaned up", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "file.bin"), Buffer.alloc(3 * MB));
    let journaled: string[] = [];
    let checked = false;
    await copyOrMove(["file.bin"], "dest", false, {
      report: (progress) => {
        if (progress.done > 0 && !checked) {
          checked = true;
          void readCopyJournal().then((entries) => { journaled = entries.map((entry) => entry.name); });
        }
      },
    });
    assert.deepEqual(journaled, ["file (copying).bin"]);
    assert.deepEqual(await readCopyJournal(), []);

    // Placeholders a restart left behind: one still as created, one replaced by someone else's item,
    // and one whose folder is now reached through a symlink.
    const identity = async (location: string) => { const stat = await fs.lstat(location); return `${stat.dev}:${stat.ino}`; };
    const real = await fs.realpath(path.join(root, "dest"));
    await fs.mkdir(path.join(root, "dest", "left (copying)"), 0o700);
    await fs.chmod(path.join(root, "dest", "left (copying)"), 0o700);
    await fs.writeFile(path.join(root, "dest", "left (copying)", "part.bin"), "partial");
    await fs.writeFile(path.join(root, "dest", "theirs (copying).txt"), "x");
    // A placeholder that has since been finished (its permissions applied) is left alone, as is one
    // whose creation time doesn't match (a reused inode).
    await fs.mkdir(path.join(root, "dest", "done (copying)"), 0o755);
    await fs.writeFile(path.join(root, "dest", "reused (copying).bin"), "x", { mode: 0o600 });
    await fs.chmod(path.join(root, "dest", "reused (copying).bin"), 0o600);
    const replacedIdentity = "1:1";
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.mkdir(path.join(root, "elsewhere", "keep (copying)"));
    await fs.rename(path.join(root, "elsewhere"), path.join(root, "elsewhere-real"));
    await fs.symlink("elsewhere-real", path.join(root, "elsewhere"));
    await recordCopy({ id: "a", directory: real, name: "left (copying)", identity: await identity(path.join(root, "dest", "left (copying)")), startedAt: "" });
    await recordCopy({ id: "b", directory: real, name: "theirs (copying).txt", identity: replacedIdentity, startedAt: "" });
    await recordCopy({ id: "c", directory: path.join(root, "elsewhere"), name: "keep (copying)", identity: await identity(path.join(root, "elsewhere-real", "keep (copying)")), startedAt: "" });
    await recordCopy({ id: "d", directory: real, name: "done (copying)", identity: await identity(path.join(root, "dest", "done (copying)")), startedAt: "" });
    await recordCopy({ id: "e", directory: real, name: "reused (copying).bin", identity: await identity(path.join(root, "dest", "reused (copying).bin")), birth: "1", startedAt: "" });
    await recoverInterruptedCopies();
    assert.deepEqual((await fs.readdir(path.join(root, "dest"))).sort(), ["done (copying)", "file.bin", "reused (copying).bin", "theirs (copying).txt"]);
    assert.deepEqual(await fs.readdir(path.join(root, "elsewhere-real")), ["keep (copying)"]);
    assert.deepEqual(await readCopyJournal(), []);
  });
});

test("trash retention removes only items deleted longer ago than the setting", async () => {
  await withTempRoot(async (root) => {
    for (const name of ["old.txt", "recent.txt"]) await fs.writeFile(path.join(root, name), name);
    await fs.mkdir(path.join(root, "old-folder"));
    await fs.writeFile(path.join(root, "old-folder", "inside.txt"), "x");
    const { trashed } = await deleteEntries(["old.txt", "recent.txt", "old-folder"]);
    const infoDir = path.join(root, ".filedude", "trash-info");
    // Backdate two of them by 40 days.
    for (const item of trashed.filter((entry) => entry.path !== "recent.txt")) {
      const infoPath = path.join(infoDir, `${item.id}.json`);
      const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
      await fs.writeFile(infoPath, JSON.stringify({ ...info, deletedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
    }
    // A legacy item (no record) named with an old timestamp, and an item with a damaged record.
    const itemsDir = path.join(root, ".filedude", "trash");
    await fs.writeFile(path.join(itemsDir, `legacy.txt.${Date.now() - 50 * 86_400_000}-abcdef`), "legacy");
    await fs.writeFile(path.join(itemsDir, "undated"), "x");
    await fs.writeFile(path.join(infoDir, "undated.json"), "not json");

    // An item with no known deletion time is kept however old it is.
    const old = new Date(Date.now() - 400 * 86_400_000);
    await fs.utimes(path.join(itemsDir, "undated"), old, old);

    const thirtyDays = async () => 30;
    const first = await purgeExpiredTrash(thirtyDays);
    assert.equal(first.removed.length, 3);
    assert.equal(first.failed, 0);
    assert.deepEqual(first.removed.map((item) => item.originalPath).sort((a, b) => String(a).localeCompare(String(b))), [null, "old-folder", "old.txt"]);
    const left = (await listTrash()).items.map((item) => item.name).sort();
    assert.deepEqual(left, ["recent.txt", "undated"]);
    assert.ok(!(await fs.readdir(infoDir)).some((name) => trashed.some((item) => item.path !== "recent.txt" && name === `${item.id}.json`)));
    assert.deepEqual(await purgeExpiredTrash(thirtyDays), { removed: [], failed: 0 });
  });
});

test("an item that can't be removed doesn't stop the purge, and turning retention off stops a run", async () => {
  await withTempRoot(async (root) => {
    const backdate = async (id: string) => {
      const infoPath = path.join(root, ".filedude", "trash-info", `${id}.json`);
      const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
      await fs.writeFile(infoPath, JSON.stringify({ ...info, deletedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
    };
    // A folder nested deeper than delete allows, plus ordinary items.
    let deep = path.join(root, "deep");
    await fs.mkdir(deep);
    for (let level = 0; level < 260; level += 1) {
      deep = path.join(deep, "d");
      await fs.mkdir(deep);
    }
    for (const name of ["a.txt", "b.txt", "c.txt"]) await fs.writeFile(path.join(root, name), name);
    const { trashed } = await deleteEntries(["deep", "a.txt", "b.txt", "c.txt"]);
    for (const item of trashed) await backdate(item.id);

    const result = await purgeExpiredTrash(async () => 30);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.removed.map((item) => item.originalPath).sort(), ["a.txt", "b.txt", "c.txt"]);
    assert.deepEqual((await listTrash()).items.map((item) => item.name), ["deep"]);

    // Retention switched off part-way: nothing more is removed.
    for (const name of ["x.txt", "y.txt"]) await fs.writeFile(path.join(root, name), name);
    for (const item of (await deleteEntries(["x.txt", "y.txt"])).trashed) await backdate(item.id);
    let checks = 0;
    const stopped = await purgeExpiredTrash(async () => (checks++ === 0 ? 30 : null));
    assert.ok(stopped.removed.length <= 1, `${stopped.removed.length} removed after retention was turned off`);
  });
});

test("the retention run does nothing until the owner chooses a period", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const { trashed } = await deleteEntries(["a.txt"]);
    const infoPath = path.join(root, ".filedude", "trash-info", `${trashed[0].id}.json`);
    const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
    await fs.writeFile(infoPath, JSON.stringify({ ...info, deletedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }));
    assert.equal((await getPreferences()).trashRetentionDays, null);
    assert.equal(await runTrashRetention(), 0);
    await savePreferences({ ...(await getPreferences()), trashRetentionDays: 7 });
    assert.equal(await runTrashRetention(), 1);
    assert.deepEqual((await listTrash()).items, []);
    const audited = (await fs.readFile(path.join(root, ".filedude", "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const purge = audited.find((entry) => entry.event === "trash.purge");
    assert.deepEqual([purge?.removed, purge?.items?.[0]?.originalPath, purge?.failed, purge?.retentionDays], [1, "a.txt", 0, 7]);
  });
});

test("service work started from an account's request doesn't run as that account", async () => {
  const editor = { accountKey: "e", username: "e", role: "editor" as const, root: "home/e" };
  const seen = await runInScope(editor, () => runUnscoped(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return currentScope();
  }));
  assert.equal(seen, undefined);
});

test("a failed copy never removes an item that took over its placeholder name", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "file.bin"), Buffer.alloc(3 * MB));
    let swapped = false;
    await assert.rejects(copyOrMove(["file.bin"], "dest", false, {
      report: (progress) => {
        if (progress.done > 0 && !swapped) {
          swapped = true;
          // Someone renames the placeholder away and puts their own file at its name.
          execFileSync("sh", ["-c", `mv "${path.join(root, "dest", "file (copying).bin")}" "${path.join(root, "dest", "moved.bin")}" && echo mine > "${path.join(root, "dest", "file (copying).bin")}"`]);
        }
      },
    }), /changed while it was being written/);
    assert.equal(await fs.readFile(path.join(root, "dest", "file (copying).bin"), "utf8"), "mine\n");
    assert.ok(!(await fs.readdir(path.join(root, "dest"))).includes("file.bin"));
  });
});

test("each account keeps only its most recent finished jobs", async () => {
  for (let index = 0; index < 30; index += 1) {
    startJob("move", `job ${index}`, { done: 0, unit: "entries" }, async () => []);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  startJob("move", "last", { done: 0, unit: "entries" }, async () => []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finished = listJobs().filter((job) => job.status === "done");
  assert.ok(finished.length <= 11, `${finished.length} finished jobs kept`);
  assert.ok(finished.some((job) => job.label === "last"));
  assert.ok(finished.every((job) => job.transferred === undefined));
});

test("a cancelled copy leaves nothing behind", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "one.bin"), Buffer.alloc(2 * MB));
    await fs.writeFile(path.join(root, "src", "two.bin"), Buffer.alloc(6 * MB));
    await fs.mkdir(path.join(root, "dest"));
    const controller = new AbortController();
    await assert.rejects(
      copyOrMove(["src"], "dest", false, { signal: controller.signal, report: (progress) => { if (progress.done >= 3 * MB) controller.abort(); } }),
      /cancelled/,
    );
    assert.deepEqual(await fs.readdir(path.join(root, "dest")), []);
    assert.deepEqual((await fs.readdir(path.join(root, "src"))).sort(), ["one.bin", "two.bin"]);
  });
});
