import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { config } from "../lib/config";
import { hashPassword } from "../lib/credentials";
import { deleteSavedSearch, forgetAccountSearches, listSavedSearches, rewriteSearchFolders, saveSearch } from "../lib/saved-searches";
import { runInScope } from "../lib/scope";

async function withState<T>(run: () => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-searches-")));
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root: path.join(base, "root"), stateDir: path.join(base, "state") });
  await fs.mkdir(config.root);
  try {
    return await run();
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

// An account (besides the owner) that exists, as saving checks.
async function addAccount(id: string, root: string) {
  await fs.mkdir(config.stateDir, { recursive: true });
  const now = new Date().toISOString();
  const file = path.join(config.stateDir, "users.json");
  const users = JSON.parse(await fs.readFile(file, "utf8").catch(() => "[]")) as unknown[];
  users.push({ id, username: id, passwordHash: await hashPassword(crypto.randomBytes(12).toString("hex")), role: "viewer", root, version: 1, createdAt: now, updatedAt: now });
  await fs.writeFile(file, JSON.stringify(users));
}

const search = (overrides: Record<string, unknown> = {}) => ({ name: "Big videos", folder: "media", query: "", mode: "names", matchCase: false, kind: "videos", modifiedDays: 0, minBytes: 1024 ** 3, ...overrides });

test("searches are saved per account, sorted by name, and a name saved again replaces the old one", async () => {
  await withState(async () => {
    await saveSearch(search());
    await saveSearch(search({ name: "Notes mentioning invoices", mode: "contents", query: "invoice", matchCase: true, kind: "any", minBytes: 0 }));
    const replaced = await saveSearch(search({ name: "big VIDEOS", minBytes: 10 * 1024 ** 3 }));
    assert.deepEqual(replaced.map((item) => [item.name, item.minBytes]), [["big VIDEOS", 10 * 1024 ** 3], ["Notes mentioning invoices", 0]]);
    // Filters only belong to name searches.
    const contents = replaced.find((item) => item.mode === "contents")!;
    assert.deepEqual([contents.kind, contents.matchCase], ["any", true]);
    await addAccount("bob", "home/bob");
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.deepEqual(await listSavedSearches(), []);
      await saveSearch(search({ name: "Mine", folder: "home/bob" }));
      assert.equal((await listSavedSearches()).length, 1);
      // Not outside the account's folder.
      await assert.rejects(saveSearch(search({ name: "Theirs", folder: "home/alice" })), /outside/);
    });
    assert.equal((await listSavedSearches()).length, 2);
    await forgetAccountSearches("bob");
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => assert.deepEqual(await listSavedSearches(), []));
    const [first] = await listSavedSearches();
    assert.equal((await deleteSavedSearch(first.id)).length, 1);
    // An account that no longer exists saves nothing.
    await runInScope({ accountKey: "gone", username: "gone", role: "viewer", root: "home/gone" }, async () => {
      await assert.rejects(saveSearch(search({ name: "Late", folder: "home/gone" })), /Sign in again/);
    });
  });
});

test("searches hidden by a change of folder don't count, and can't be deleted or replaced", async () => {
  await withState(async () => {
    await addAccount("bob", "home/bob");
    const bob = (root: string) => ({ accountKey: "bob", username: "bob", role: "viewer" as const, root });
    const hiddenIds = await runInScope(bob("home/bob"), async () => {
      for (let index = 0; index < 50; index += 1) await saveSearch(search({ name: `Search ${index}`, folder: "home/bob" }));
      await assert.rejects(saveSearch(search({ name: "One more", folder: "home/bob" })), /Up to 50/);
      return (await listSavedSearches()).map((item) => item.id);
    });
    // Bob's folder changes: his old searches are hidden, and he can save new ones.
    await runInScope(bob("home/shared"), async () => {
      assert.deepEqual(await listSavedSearches(), []);
      assert.equal((await saveSearch(search({ name: "Search 1", folder: "home/shared" }))).length, 1);
      assert.equal((await deleteSavedSearch(hiddenIds[0])).length, 1);
    });
    // And back again, the old ones are all still there (with the one of the same name).
    await runInScope(bob("home"), async () => assert.equal((await listSavedSearches()).length, 51));
  });
});

test("a damaged file reads as empty and is kept aside when next saved", async () => {
  await withState(async () => {
    await fs.mkdir(config.stateDir, { recursive: true });
    const file = path.join(config.stateDir, "saved-searches.json");
    await fs.writeFile(file, "{\"accounts\": {\"owner\": [");
    assert.deepEqual(await listSavedSearches(), []);
    assert.equal((await saveSearch(search())).length, 1);
    assert.equal(await fs.readFile(`${file}.bad`, "utf8"), "{\"accounts\": {\"owner\": [");
    assert.equal((await listSavedSearches()).length, 1);
  });
});

test("what's saved is checked", async () => {
  await withState(async () => {
    for (const bad of [search({ name: "" }), search({ name: "x".repeat(81) }), search({ folder: "../etc" }), search({ mode: "regex" }), search({ kind: "secrets" }), search({ minBytes: -1 }), search({ modifiedDays: Number.NaN }), search({ query: "q".repeat(257) }), search({ kind: "any", minBytes: 0 }), search({ mode: "contents", query: "" })]) {
      await assert.rejects(saveSearch(bad), JSON.stringify(bad).slice(0, 80));
    }
    // Control characters are taken out of names.
    assert.equal((await saveSearch(search({ name: "Re\u202Eport" })))[0].name, "Report");
  });
});

test("saved searches follow their folder when it's renamed or moved, and go when it's deleted", async () => {
  await withState(async () => {
    await saveSearch(search({ name: "A", folder: "media/films" }));
    await saveSearch(search({ name: "B", folder: "media/films/old" }));
    await saveSearch(search({ name: "C", folder: "music" }));
    await rewriteSearchFolders([{ from: "media/films", to: "archive/films" }]);
    assert.deepEqual((await listSavedSearches()).map((item) => [item.name, item.folder]), [["A", "archive/films"], ["B", "archive/films/old"], ["C", "music"]]);
    await rewriteSearchFolders([{ from: "music" }]);
    assert.deepEqual((await listSavedSearches()).map((item) => item.name), ["A", "B"]);
    // A folder merely starting with the same letters isn't affected.
    await saveSearch(search({ name: "D", folder: "archive/films-extra" }));
    await rewriteSearchFolders([{ from: "archive/films", to: "x" }]);
    assert.deepEqual((await listSavedSearches()).map((item) => item.folder).sort(), ["archive/films-extra", "x", "x/old"]);
  });
});
