import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { inside, openDirectory, withOpen } from "../lib/files";
import { cancelAccountJobs, getJob, startJob } from "../lib/jobs";
import { runInScope, type AccessScope } from "../lib/scope";
import { createUser, deleteUser, updateUser } from "../lib/users";
import { POST as login } from "../app/api/auth/login/route";
import { POST as preferences } from "../app/api/auth/preferences/route";
import { GET as archiveStatus, POST as archive } from "../app/api/fs/archive/route";
import { GET as download } from "../app/api/fs/download/route";
import { GET as largest } from "../app/api/fs/largest/route";
import { GET as listFs, POST as fsAction } from "../app/api/fs/route";
import { GET as trashList, POST as trashAction } from "../app/api/fs/trash/route";
import { POST as upload } from "../app/api/fs/upload/route";
import { GET as favoritesList, POST as favoritesAction } from "../app/api/favorites/route";
import { GET as sharesList } from "../app/api/shares/route";
import { GET as usersList, POST as usersAction } from "../app/api/users/route";

type Handler = (request: Request) => Promise<Response>;

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const OWNER_PASSWORD = "owner-test-password-long";
const USER_PASSWORD = "user-test-password-long";

async function withAccounts<T>(run: (context: { root: string; owner: string; bob: string; viewer: string; alice: string; ids: { bob: string; viewer: string; alice: string } }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-accounts-")));
  const root = path.join(base, "root");
  for (const folder of ["home/bob/docs", "home/alice", "shared"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, "home", "alice", "diary.txt"), "alice's secret");
  await fs.writeFile(path.join(root, "home", "bob", "docs", "plan.txt"), "bob's plan");
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, username: config.username };
  Object.assign(config, {
    root,
    stateDir: path.join(base, "state"),
    username: "owner",
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt(OWNER_PASSWORD, salt)).toString("base64url")}`,
    sessionSecret: "accounts-test-session-secret-with-more-than-32-characters",
  });
  try {
    const credentials = await getCredentials();
    const bob = await createUser({ username: "bob", password: USER_PASSWORD, role: "editor", root: "home/bob" });
    const alice = await createUser({ username: "alice", password: USER_PASSWORD, role: "editor", root: "home/alice" });
    const viewer = await createUser({ username: "guest", password: USER_PASSWORD, role: "viewer", root: "shared" });
    const cookie = (username: string, key: string) => `fd_session=${createSession(username, 1, key)}`;
    return await run({
      root,
      owner: `fd_session=${createSession(credentials.username, credentials.version)}`,
      bob: cookie("bob", bob.id),
      alice: cookie("alice", alice.id),
      viewer: cookie("guest", viewer.id),
      ids: { bob: bob.id, alice: alice.id, viewer: viewer.id },
    });
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

function call(handler: Handler, url: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) Object.assign(headers, { "content-type": "application/json", "x-filedude-request": "1" });
  return handler(new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const status = async (response: Promise<Response>) => (await response).status;

test("every API route authenticates through the access wrapper", async () => {
  const routes: string[] = [];
  async function collect(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(location);
      else if (entry.name === "route.ts") routes.push(location);
    }
  }
  await collect(path.join(process.cwd(), "app", "api"));
  const unauthenticated = new Set(["auth/login", "auth/logout", "auth/status"].map((route) => path.join(process.cwd(), "app", "api", route, "route.ts")));
  assert.ok(routes.length >= 15);
  for (const route of routes) {
    const source = await fs.readFile(route, "utf8");
    assert.doesNotMatch(source, /requireSession\(/, `${route} must use withAccess, not requireSession`);
    if (!unauthenticated.has(route)) assert.match(source, /withAccess\(/, `${route} must authenticate with withAccess`);
  }
});

test("owners and accounts sign in; wrong or unknown credentials are refused", async () => {
  await withAccounts(async () => {
    const attempt = (username: string, password: string) => login(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-filedude-request": "1" }, body: JSON.stringify({ username, password }) }));
    const bob = await attempt("bob", USER_PASSWORD);
    assert.equal(bob.status, 200);
    const cookie = (bob.headers.get("set-cookie") || "").split(";")[0];
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", cookie)), 200);
    assert.equal(await status(call(listFs, "/api/fs?path=", cookie)), 403);
    assert.equal((await attempt("owner", OWNER_PASSWORD)).status, 200);
    assert.equal((await attempt("bob", "wrong-password-here")).status, 401);
    assert.equal((await attempt("nobody", USER_PASSWORD)).status, 401);
  });
});

test("sessions from before accounts existed still belong to the owner", async () => {
  await withAccounts(async ({ owner }) => {
    const credentials = await getCredentials();
    const payload = Buffer.from(JSON.stringify({ u: credentials.username, v: credentials.version, exp: Date.now() + 60_000, nonce: "x" })).toString("base64url");
    const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    assert.equal(await status(call(listFs, "/api/fs?path=", `fd_session=${payload}.${signature}`)), 200);
    assert.equal(await status(call(listFs, "/api/fs?path=", owner)), 200);
  });
});

test("accounts are confined to their folder, including through symlinks", async () => {
  await withAccounts(async ({ root, bob }) => {
    await fs.symlink("../alice", path.join(root, "home", "bob", "alice-link"));
    for (const target of ["", "home", "home/alice", "home/bob/../alice", "shared"]) {
      assert.equal(await status(call(listFs, `/api/fs?path=${encodeURIComponent(target)}`, bob)), 403, target);
    }
    const listing = await (await call(listFs, "/api/fs?path=home/bob", bob)).json();
    assert.equal(listing.entries.find((entry: { name: string }) => entry.name === "alice-link").symlinkBlocked, true);
    assert.equal(await status(call(download, "/api/fs/download?path=home/bob/alice-link/diary.txt", bob)), 403);
    assert.equal(await status(call(download, "/api/fs/download?path=home/alice/diary.txt", bob)), 403);
    assert.equal(await status(call(download, "/api/fs/download?path=home/bob/docs/plan.txt", bob)), 200);
    const moved = await call(fsAction, "/api/fs", bob, { action: "move", paths: ["home/bob/docs/plan.txt"], destination: "home/alice" });
    assert.equal(moved.status, 403);
    assert.equal(await fs.readFile(path.join(root, "home", "bob", "docs", "plan.txt"), "utf8"), "bob's plan");
  });
});

test("viewers can only read and editors can't do owner-only things", async () => {
  await withAccounts(async ({ bob, viewer }) => {
    assert.equal(await status(call(listFs, "/api/fs?path=shared", viewer)), 200);
    assert.equal(await status(call(fsAction, "/api/fs", viewer, { action: "create", path: "shared", name: "new.txt", type: "file" })), 403);
    assert.equal(await status(call(fsAction, "/api/fs", viewer, { action: "details", path: "shared" })), 200);
    assert.equal(await status(call(trashList, "/api/fs/trash", viewer)), 403);
    assert.equal(await status(call(archive, "/api/fs/archive", viewer, { action: "extract", path: "shared/x.zip" })), 403);

    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "create", path: "home/bob", name: "new.txt", type: "file" })), 200);
    for (const [handler, url, body] of [
      [fsAction, "/api/fs", { action: "chmod", paths: ["home/bob/new.txt"], mode: "600" }],
      [fsAction, "/api/fs", { action: "chown", paths: ["home/bob/new.txt"], uid: 0, gid: 0 }],
      [sharesList, "/api/shares", undefined],
      [largest, "/api/fs/largest", undefined],
      [usersList, "/api/users", undefined],
      [usersAction, "/api/users", { action: "create", username: "mallory", password: USER_PASSWORD, role: "editor", root: "" }],
      [trashAction, "/api/fs/trash", { action: "empty" }],
    ] as Array<[Handler, string, unknown]>) {
      assert.equal(await status(call(handler, url, bob, body)), 403, url);
    }
  });
});

test("accounts can't rename, move, or delete their own home folder", async () => {
  await withAccounts(async ({ root, bob }) => {
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "delete", paths: ["home/bob"] })), 403);
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "rename", path: "home/bob", name: "bobby" })), 403);
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "bulkRename", paths: ["home/bob/"], rule: { suffix: "-x" }, apply: true })), 403);
    assert.ok((await fs.stat(path.join(root, "home", "bob"))).isDirectory());
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "delete", paths: ["home/bob/docs"] })), 200);
  });
});

test("the trash shows each account only what was deleted from its folder", async () => {
  await withAccounts(async ({ owner, bob }) => {
    const aliceDelete = await (await call(fsAction, "/api/fs", owner, { action: "delete", paths: ["home/alice/diary.txt"] })).json();
    await call(fsAction, "/api/fs", bob, { action: "delete", paths: ["home/bob/docs/plan.txt"] });
    const bobTrash = await (await call(trashList, "/api/fs/trash", bob)).json();
    assert.deepEqual(bobTrash.items.map((item: { name: string }) => item.name), ["plan.txt"]);
    const ownerTrash = await (await call(trashList, "/api/fs/trash", owner)).json();
    assert.equal(ownerTrash.items.length, 2);
    const aliceId = aliceDelete.result.trashed[0].id;
    assert.equal(await status(call(trashAction, "/api/fs/trash", bob, { action: "restore", ids: [aliceId] })), 404);
    assert.equal(await status(call(trashAction, "/api/fs/trash", bob, { action: "delete", ids: [aliceId] })), 404);
    assert.equal(await status(call(trashAction, "/api/fs/trash", owner, { action: "restore", ids: [aliceId] })), 200);
  });
});

test("changing or deleting an account signs it out everywhere", async () => {
  await withAccounts(async ({ bob, viewer, ids }) => {
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", bob)), 200);
    await updateUser(ids.bob, { role: "viewer" });
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", bob)), 401);
    await deleteUser(ids.viewer);
    assert.equal(await status(call(listFs, "/api/fs?path=shared", viewer)), 401);
  });
});

test("favourites are per account and follow renames made by anyone", async () => {
  await withAccounts(async ({ owner, bob }) => {
    await call(favoritesAction, "/api/favorites", bob, { action: "add", path: "home/bob/docs" });
    assert.deepEqual((await (await call(favoritesList, "/api/favorites", owner)).json()).favorites, []);
    await call(fsAction, "/api/fs", owner, { action: "rename", path: "home/bob/docs", name: "papers" });
    const bobFavorites = (await (await call(favoritesList, "/api/favorites", bob)).json()).favorites;
    assert.deepEqual(bobFavorites.map((favorite: { path: string }) => favorite.path), ["home/bob/papers"]);
  });
});

test("accounts see only their own archive jobs; the owner sees all", async () => {
  await withAccounts(async ({ owner, bob, alice }) => {
    const started = await (await call(archive, "/api/fs/archive", bob, { action: "compress", paths: ["home/bob/docs"], destination: "home/bob", name: "docs", format: "zip" })).json();
    const jobId = started.job.id;
    assert.equal(await status(call(archiveStatus, `/api/fs/archive?id=${jobId}`, bob)), 200);
    assert.equal(await status(call(archiveStatus, `/api/fs/archive?id=${jobId}`, owner)), 200);
    assert.equal(await status(call(archiveStatus, `/api/fs/archive?id=${jobId}`, alice)), 404);
    assert.deepEqual((await (await call(archiveStatus, "/api/fs/archive", alice)).json()).jobs, []);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = (await (await call(archiveStatus, `/api/fs/archive?id=${jobId}`, bob)).json()).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});

test("only the owner chooses upload ownership, and usernames stay unique", async () => {
  await withAccounts(async ({ owner, bob }) => {
    const response = await upload(new Request("http://localhost/api/fs/upload?path=home/bob&uid=0&gid=0", { method: "POST", headers: { cookie: bob, "x-filedude-request": "1", "content-type": "multipart/form-data; boundary=x" }, body: "--x--\r\n" }));
    assert.equal(response.status, 403);
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "create", username: "BOB", password: USER_PASSWORD, role: "viewer", root: "shared" })), 409);
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "create", username: "owner", password: USER_PASSWORD, role: "viewer", root: "shared" })), 409);
    assert.equal(await status(call(preferences, "/api/auth/preferences", owner, { username: "alice", currentPassword: OWNER_PASSWORD })), 409);
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "create", username: "carol", password: USER_PASSWORD, role: "editor", root: "home/missing" })), 404);
  });
});

test("accounts can't be given the whole root", async () => {
  await withAccounts(async ({ owner, ids }) => {
    for (const root of ["", "/", "."]) {
      assert.equal(await status(call(usersAction, "/api/users", owner, { action: "create", username: "carol", password: USER_PASSWORD, role: "editor", root })), 400, root);
      assert.equal(await status(call(usersAction, "/api/users", owner, { action: "update", id: ids.bob, root })), 400, root);
    }
  });
});

test("copies and deletes never follow symlinks or open special files", async () => {
  await withAccounts(async ({ root, bob }) => {
    const home = path.join(root, "home", "bob");
    await fs.symlink("../../alice", path.join(home, "docs", "alice-link"));
    await fs.chmod(path.join(home, "docs", "plan.txt"), 0o640);
    const copied = await call(fsAction, "/api/fs", bob, { action: "copy", paths: ["home/bob/docs"], destination: "home/bob" });
    assert.equal(copied.status, 200);
    const copy = path.join(home, "docs (copy)");
    assert.equal(await fs.readFile(path.join(copy, "plan.txt"), "utf8"), "bob's plan");
    assert.equal((await fs.stat(path.join(copy, "plan.txt"))).mode & 0o777, 0o640);
    assert.equal(await fs.readlink(path.join(copy, "alice-link")), "../../alice");

    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "delete", paths: ["home/bob/docs (copy)"], permanent: true })), 200);
    await assert.rejects(fs.lstat(copy));
    assert.equal(await fs.readFile(path.join(root, "home", "alice", "diary.txt"), "utf8"), "alice's secret");

    // Copying a FIFO used to block on opening it; it is refused instead.
    execFileSync("mkfifo", [path.join(home, "pipe")]);
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "copy", paths: ["home/bob/pipe"], destination: "home/bob/docs" })), 400);
    await assert.rejects(fs.lstat(path.join(home, "docs", "pipe")));
  });
});

test("renaming onto a hardlink of the same file is a conflict, not a case-only rename", async () => {
  await withAccounts(async ({ root, bob }) => {
    const docs = path.join(root, "home", "bob", "docs");
    await fs.link(path.join(docs, "plan.txt"), path.join(docs, "other.txt"));
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "rename", path: "home/bob/docs/plan.txt", name: "other.txt" })), 409);
    assert.deepEqual((await fs.readdir(docs)).sort(), ["other.txt", "plan.txt"]);
  });
});

test("work continues in the folder that was checked even if its path is swapped for a symlink", { skip: process.platform !== "linux" && "needs /proc/self/fd" }, async () => {
  await withAccounts(async ({ root }) => {
    const docs = path.join(root, "home", "bob", "docs");
    await withOpen(openDirectory("home/bob/docs"), async (directory) => {
      await fs.rename(docs, `${docs}-old`);
      await fs.symlink("../alice", docs);
      await fs.writeFile(inside(directory, "new.txt"), "written");
      await fs.rename(inside(directory, "plan.txt"), inside(directory, "plan-2.txt"));
    });
    assert.equal(await fs.readFile(path.join(`${docs}-old`, "new.txt"), "utf8"), "written");
    assert.ok(await fs.lstat(path.join(`${docs}-old`, "plan-2.txt")));
    assert.deepEqual(await fs.readdir(path.join(root, "home", "alice")), ["diary.txt"]);
  });
});

test("each account runs its own jobs, which stop when the account changes", async () => {
  await withAccounts(async ({ owner, ids }) => {
    const scope = (accountKey: string, root: string): AccessScope => ({ accountKey, username: accountKey, role: "editor", root });
    const waitForCancel = (_report: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    });
    const start = (accountKey: string, root: string) => runInScope(scope(accountKey, root), () => startJob("compress", accountKey, { done: 0, unit: "bytes" }, waitForCancel));
    const bobJob = start(ids.bob, "home/bob");
    const aliceJob = start(ids.alice, "home/alice");
    assert.throws(() => start(ids.bob, "home/bob"), /still running/);
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "update", id: ids.bob, role: "viewer" })), 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getJob(bobJob.id)?.status, "cancelled");
    assert.equal(getJob(aliceJob.id)?.status, "running");
    cancelAccountJobs(ids.alice);
  });
});

test("accounts change their own password, which signs out their other sessions", async () => {
  await withAccounts(async ({ bob }) => {
    assert.equal(await status(call(preferences, "/api/auth/preferences", bob, { username: "robert", currentPassword: USER_PASSWORD })), 403);
    assert.equal(await status(call(preferences, "/api/auth/preferences", bob, { newPassword: "brand-new-password-1", currentPassword: "wrong-password-here" })), 401);
    const changed = await call(preferences, "/api/auth/preferences", bob, { newPassword: "brand-new-password-1", currentPassword: USER_PASSWORD });
    assert.equal(changed.status, 200);
    const fresh = (changed.headers.get("set-cookie") || "").split(";")[0];
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", bob)), 401);
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", fresh)), 200);
  });
});
