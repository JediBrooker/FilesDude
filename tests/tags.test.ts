import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { runInScope } from "../lib/scope";
import { clearTags, flushTags, forgetAccountTags, setTag, tagCounts, taggedWith, tagsIn } from "../lib/tags";
import { rewriteLinkedPaths } from "../lib/transfers";
import { createUser } from "../lib/users";
import { GET as tags, POST as tagAction } from "../app/api/tags/route";
import { POST as usersAction } from "../app/api/users/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (context: { root: string; state: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-tags-")));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  for (const folder of ["docs/old", "home/bob", "home/alice"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const file of ["docs/plan.txt", "docs/old/notes.txt", "report.pdf", "__proto__", "home/bob/mine.txt", "home/alice/secret.txt"]) await fs.writeFile(path.join(root, file), "x");
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  Object.assign(config, { root, stateDir: state, passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("tags-test-password", salt)).toString("base64url")}`, sessionSecret: "tags-test-session-secret-with-more-than-32-characters" });
  try {
    return await run({ root, state });
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("items get colour tags, shown per folder, counted, and listed by colour", async () => {
  await withRoot(async ({ state }) => {
    assert.deepEqual(await setTag(["docs/plan.txt", "docs/old"], "red", true), [{ path: "docs/plan.txt", colors: ["red"] }, { path: "docs/old", colors: ["red"] }]);
    // Colours keep a fixed order, and adding one twice changes nothing.
    await setTag(["docs/plan.txt"], "blue", true);
    await setTag(["docs/plan.txt"], "red", true);
    assert.deepEqual(await tagsIn("docs"), [{ path: "docs/plan.txt", colors: ["red", "blue"] }, { path: "docs/old", colors: ["red"] }]);
    assert.deepEqual(await tagsIn(""), []);
    await setTag(["report.pdf", "__proto__"], "green", true);
    assert.deepEqual((await tagsIn("")).map((item) => item.path).sort(), ["__proto__", "report.pdf"]);
    const counts = await tagCounts();
    assert.deepEqual([counts.red, counts.blue, counts.green, counts.gray], [2, 1, 2, 0]);
    const red = await taggedWith("red");
    assert.deepEqual(red.map((item) => [item.name, item.type, item.mime]), [["old", "directory", "inode/directory"], ["plan.txt", "file", "text/plain"]]);
    // Taking a colour off; the last one removes the item.
    await setTag(["docs/plan.txt"], "red", false);
    assert.deepEqual(await tagsIn("docs"), [{ path: "docs/plan.txt", colors: ["blue"] }, { path: "docs/old", colors: ["red"] }]);
    await clearTags(["docs/plan.txt", "docs/old"]);
    assert.deepEqual(await tagsIn("docs"), []);
    // Kept in memory, then written out.
    await flushTags();
    assert.equal((await fs.stat(path.join(state, "tags.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(state, "tags.json"), "utf8")).accounts.owner.map((item: [string]) => item[0]).sort(), ["__proto__", "report.pdf"]);
    // A file named __proto__ is just a name.
    assert.equal(({} as Record<string, unknown>).green, undefined);
  });
});

test("only real colours, and items that exist inside the account's folder, can be tagged", async () => {
  await withRoot(async () => {
    await assert.rejects(setTag(["report.pdf"], "pink", true), /tag colour/);
    await assert.rejects(setTag([], "red", true), /Choose between/);
    await assert.rejects(setTag("report.pdf", "red", true), /Choose between/);
    await assert.rejects(setTag([""], "red", true), /top folder/);
    await assert.rejects(setTag(["missing.txt"], "red", true), (error: Error & { status?: number }) => error.status === 404);
    await assert.rejects(setTag(["../outside"], "red", true));
    await assert.rejects(setTag(Array.from({ length: 1001 }, () => "report.pdf"), "red", true), /Choose between/);
    await assert.rejects(taggedWith("pink"), /tag colour/);
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      await assert.rejects(setTag(["home/alice/secret.txt"], "red", true), /outside your folder/);
      await assert.rejects(setTag(["home/bob"], "red", true), /top folder/);
      await setTag(["home/bob/mine.txt"], "red", true);
      assert.deepEqual((await taggedWith("red")).map((item) => item.path), ["home/bob/mine.txt"]);
    });
    // Each account has its own tags.
    assert.deepEqual(await taggedWith("red"), []);
    assert.equal((await tagCounts()).red, 0);
  });
});

test("tags follow renames and moves, go with deletes, and hide what has gone or is out of reach", async () => {
  await withRoot(async ({ root }) => {
    await setTag(["docs/old/notes.txt", "docs/old", "report.pdf"], "purple", true);
    await runInScope({ accountKey: "bob", username: "bob", role: "editor", root: "" }, () => setTag(["docs/old/notes.txt"], "yellow", true));
    await fs.rename(path.join(root, "docs", "old"), path.join(root, "archive"));
    await rewriteLinkedPaths([{ from: "docs/old", to: "archive" }], "owner");
    assert.deepEqual((await tagsIn("")).map((item) => item.path).sort(), ["archive", "report.pdf"]);
    assert.deepEqual(await tagsIn("archive"), [{ path: "archive/notes.txt", colors: ["purple"] }]);
    // Every account's tags follow.
    await runInScope({ accountKey: "bob", username: "bob", role: "editor", root: "" }, async () => assert.deepEqual(await tagsIn("archive"), [{ path: "archive/notes.txt", colors: ["yellow"] }]));
    await rewriteLinkedPaths([{ from: "report.pdf" }], "owner");
    assert.deepEqual((await taggedWith("purple")).map((item) => item.path), ["archive", "archive/notes.txt"]);
    // Removed some other way: still counted, but not listed.
    await fs.rm(path.join(root, "archive", "notes.txt"));
    assert.deepEqual((await taggedWith("purple")).map((item) => item.path), ["archive"]);
    // A name that only starts the same isn't affected.
    await setTag(["docs/plan.txt"], "gray", true);
    await rewriteLinkedPaths([{ from: "doc", to: "x" }], "owner");
    assert.deepEqual(await tagsIn("docs"), [{ path: "docs/plan.txt", colors: ["gray"] }]);
  });
});

test("FilesDude's own folders can't be tagged through a link, and gone items lose their tags when listed", async () => {
  await withRoot(async ({ root }) => {
    await fs.mkdir(path.join(root, ".filedude"), { recursive: true });
    await fs.symlink(".filedude", path.join(root, "sneaky"));
    await assert.rejects(setTag(["sneaky"], "red", true), /reserved/);
    await setTag(["report.pdf", "docs/plan.txt"], "orange", true);
    await fs.rm(path.join(root, "report.pdf"));
    assert.equal((await tagCounts()).orange, 2);
    assert.deepEqual((await taggedWith("orange")).map((item) => item.path), ["docs/plan.txt"]);
    // The gone item's tag was dropped.
    assert.equal((await tagCounts()).orange, 1);
  });
});

test("tags moved out of an account's folder don't count towards its limit", async () => {
  await withRoot(async ({ root }) => {
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, () => setTag(["home/bob/mine.txt"], "red", true));
    await fs.rename(path.join(root, "home", "bob", "mine.txt"), path.join(root, "mine.txt"));
    await rewriteLinkedPaths([{ from: "home/bob/mine.txt", to: "mine.txt" }], "owner");
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.equal((await tagCounts()).red, 0);
      assert.deepEqual(await taggedWith("red"), []);
    });
  });
});

test("a damaged file is kept aside, odd entries are ignored, and a removed account's tags go", async () => {
  await withRoot(async ({ state }) => {
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "tags.json"), JSON.stringify({ accounts: { owner: [["report.pdf", ["red", "pink"]], [5, ["red"]], "junk"], other: "not a list" } }));
    assert.deepEqual(await tagsIn(""), [{ path: "report.pdf", colors: ["red"] }]);
    await forgetAccountTags("owner");
    assert.deepEqual(await tagsIn(""), []);
  });
  // A damaged file found when the tags are first read.
  await withRoot(async ({ state }) => {
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "tags.json"), "{\"accounts\": [tor");
    assert.deepEqual(await tagsIn(""), []);
    assert.equal(await fs.readFile(path.join(state, "tags.json.bad"), "utf8"), "{\"accounts\": [tor");
  });
});

test("the API needs a signed-in, same-site request and is per account", async () => {
  await withRoot(async () => {
    const credentials = await getCredentials();
    const owner = `fd_session=${createSession(credentials.username, credentials.version)}`;
    const bob = await createUser({ username: "bob", password: "bob-test-password-long", role: "viewer", root: "home/bob" });
    const bobCookie = `fd_session=${createSession("bob", 1, bob.id)}`;
    const call = (handler: (request: Request) => Promise<Response>, url: string, cookie: string, body?: unknown, headers: Record<string, string> = { "x-filedude-request": "1" }) =>
      handler(new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json", ...headers }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    assert.equal((await call(tags, "/api/tags", "")).status, 401);
    assert.equal((await call(tagAction, "/api/tags", bobCookie, { action: "set", paths: ["home/bob/mine.txt"], color: "red", on: true }, {})).status, 403);
    const set = await call(tagAction, "/api/tags", bobCookie, { action: "set", paths: ["home/bob/mine.txt"], color: "red", on: true });
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as { counts: { red: number } }).counts.red, 1);
    assert.equal((await call(tagAction, "/api/tags", bobCookie, { action: "set", paths: ["home/alice/secret.txt"], color: "red", on: true })).status, 403);
    assert.equal((await call(tagAction, "/api/tags", bobCookie, { action: "nonsense" })).status, 400);
    assert.deepEqual(((await (await call(tags, "/api/tags?folder=home/bob", bobCookie)).json()) as { tags: unknown[] }).tags, [{ path: "home/bob/mine.txt", colors: ["red"] }]);
    assert.equal(((await (await call(tags, "/api/tags?color=red", bobCookie)).json()) as { entries: unknown[] }).entries.length, 1);
    assert.equal(((await (await call(tags, "/api/tags", owner)).json()) as { counts: { red: number } }).counts.red, 0);
    assert.equal((await call(usersAction, "/api/users", owner, { action: "delete", id: bob.id })).status, 200);
    await runInScope({ accountKey: bob.id, username: "bob", role: "viewer", root: "home/bob" }, async () => assert.equal((await tagCounts()).red, 0));
  });
});
