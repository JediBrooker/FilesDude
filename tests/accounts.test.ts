import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearLoginFailures, createSession } from "../lib/auth";
import { currentStep, totpAt } from "../lib/totp";
import { getCredentials as readCredentials } from "../lib/credentials";
import { GET as twoFactorStatus, POST as twoFactorAction } from "../app/api/auth/two-factor/route";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { inside, openDirectory, withOpen } from "../lib/files";
import { cancelAccountJobs, getJob, startJob } from "../lib/jobs";
import { runInScope, type AccessScope } from "../lib/scope";
import { createUser, deleteUser, updateUser } from "../lib/users";
import { POST as login } from "../app/api/auth/login/route";
import { GET as readPreferences, POST as preferences } from "../app/api/auth/preferences/route";
import { GET as archiveStatus, POST as archive } from "../app/api/fs/archive/route";
import { GET as download } from "../app/api/fs/download/route";
import { GET as largest } from "../app/api/fs/largest/route";
import { GET as listFs, POST as fsAction } from "../app/api/fs/route";
import { GET as trashList, POST as trashAction } from "../app/api/fs/trash/route";
import { POST as upload } from "../app/api/fs/upload/route";
import { GET as favoritesList, POST as favoritesAction } from "../app/api/favorites/route";
import { GET as jobsStatus, POST as jobsAction } from "../app/api/fs/jobs/route";
import { GET as snapshotsInfo, POST as snapshotsAction } from "../app/api/fs/snapshots/route";
import { GET as snapshotDownload } from "../app/api/fs/snapshots/download/route";
import { setZfsRunner } from "../lib/snapshots";
import { GET as duplicatesInfo, POST as duplicatesAction } from "../app/api/fs/duplicates/route";
import { waitForDuplicateScan } from "../lib/duplicates";
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
  const unauthenticated = new Set(["auth/login", "auth/passkey-login", "auth/logout", "auth/status"].map((route) => path.join(process.cwd(), "app", "api", route, "route.ts")));
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

test("undo-style moves still work while background transfers fill the allowance", async () => {
  await withAccounts(async ({ root, bob, ids }) => {
    const scope: AccessScope = { accountKey: ids.bob, username: "bob", role: "editor", root: "home/bob" };
    const waitForCancel = (_report: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    });
    for (let index = 0; index < 4; index += 1) runInScope(scope, () => startJob("copy", `copy ${index}`, { done: 0, unit: "bytes" }, waitForCancel));
    await fs.mkdir(path.join(root, "home", "bob", "elsewhere"));
    assert.equal(await status(call(jobsAction, "/api/fs/jobs", bob, { action: "copy", paths: ["home/bob/docs"], destination: "home/bob/elsewhere" })), 409);
    assert.equal(await status(call(fsAction, "/api/fs", bob, { action: "move", paths: ["home/bob/docs"], destination: "home/bob/elsewhere" })), 200);
    cancelAccountJobs(ids.bob);
  });
});

test("copy and move jobs respect accounts and keep favourites following moved items", async () => {
  await withAccounts(async ({ root, bob, alice, viewer }) => {
    const start = (cookie: string, body: Record<string, unknown>) => call(jobsAction, "/api/fs/jobs", cookie, body);
    assert.equal(await status(start(viewer, { action: "copy", paths: ["shared"], destination: "shared" })), 403);
    const escaped = await (await start(bob, { action: "copy", paths: ["home/bob/docs/plan.txt"], destination: "home/alice" })).json();
    assert.equal(escaped.job.status, "failed");
    assert.deepEqual(await fs.readdir(path.join(root, "home", "alice")), ["diary.txt"]);

    await call(favoritesAction, "/api/favorites", bob, { action: "add", path: "home/bob/docs" });
    await fs.mkdir(path.join(root, "home", "bob", "archive"));
    // A quick move comes back already finished.
    const moved = await (await start(bob, { action: "move", paths: ["home/bob/docs"], destination: "home/bob/archive" })).json();
    assert.equal(moved.job.status, "done");
    assert.equal(moved.job.own, true);
    assert.deepEqual(moved.job.transferred, [{ source: "home/bob/docs", path: "home/bob/archive/docs", renamed: false }]);
    const favourites = (await (await call(favoritesList, "/api/favorites", bob)).json()).favorites;
    assert.deepEqual(favourites.map((favorite: { path: string }) => favorite.path), ["home/bob/archive/docs"]);

    assert.equal(await status(call(jobsStatus, `/api/fs/jobs?id=${moved.job.id}`, bob)), 200);
    assert.equal(await status(call(jobsStatus, `/api/fs/jobs?id=${moved.job.id}`, alice)), 404);
    assert.equal(await status(call(jobsAction, "/api/fs/jobs", alice, { action: "cancel", id: moved.job.id })), 404);
  });
});

test("only the owner sets trash retention, and the trash shows it", async () => {
  await withAccounts(async ({ owner, bob }) => {
    assert.equal(await status(call(preferences, "/api/auth/preferences", bob, { trashRetentionDays: 7 })), 403);
    for (const invalid of [0, -1, 1.5, "30", 4000]) {
      assert.equal(await status(call(preferences, "/api/auth/preferences", owner, { trashRetentionDays: invalid })), 400, String(invalid));
    }
    assert.equal(await status(call(preferences, "/api/auth/preferences", owner, { trashRetentionDays: 30 })), 200);
    assert.equal((await (await call(readPreferences, "/api/auth/preferences", owner)).json()).trashRetentionDays, 30);
    assert.equal((await (await call(trashList, "/api/fs/trash", bob)).json()).retentionDays, 30);
    // Upload ownership survives a retention-only change, and retention survives an ownership change.
    assert.equal(await status(call(preferences, "/api/auth/preferences", owner, { uploadOwnership: { mode: "service" } })), 200);
    const saved = await (await call(readPreferences, "/api/auth/preferences", owner)).json();
    assert.deepEqual([saved.trashRetentionDays, saved.uploadOwnership], [30, { mode: "service" }]);
    assert.equal(await status(call(preferences, "/api/auth/preferences", owner, { trashRetentionDays: null })), 200);
    assert.equal((await (await call(readPreferences, "/api/auth/preferences", owner)).json()).trashRetentionDays, null);
  });
});

const cookieFrom = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];
const signIn = (body: Record<string, unknown>) => login(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-filedude-request": "1" }, body: JSON.stringify(body) }));

// Turns two-factor sign-in on for an account and returns its secret, recovery codes, and new cookie.
async function enableTwoFactor(cookie: string, password: string) {
  const setup = await (await call(twoFactorAction, "/api/auth/two-factor", cookie, { action: "setup", currentPassword: password })).json();
  assert.match(setup.qr, /^data:image\/svg\+xml;base64,/);
  const enabled = await call(twoFactorAction, "/api/auth/two-factor", cookie, { action: "enable", setupToken: setup.setupToken, code: totpAt(setup.secret, currentStep()) });
  assert.equal(enabled.status, 200);
  return { secret: setup.secret as string, recoveryCodes: (await enabled.json()).recoveryCodes as string[], cookie: cookieFrom(enabled) };
}

test("two-factor sign-in: setup, codes used once, recovery codes, and attempts", async () => {
  await withAccounts(async ({ bob }) => {
    clearLoginFailures("direct-client");
    assert.equal(await status(call(twoFactorAction, "/api/auth/two-factor", bob, { action: "setup", currentPassword: "wrong-password-here" })), 401);
    const setup = await (await call(twoFactorAction, "/api/auth/two-factor", bob, { action: "setup", currentPassword: USER_PASSWORD })).json();
    assert.equal(await status(call(twoFactorAction, "/api/auth/two-factor", bob, { action: "enable", setupToken: setup.setupToken, code: "000000" })), 400);
    assert.equal(await status(call(twoFactorAction, "/api/auth/two-factor", bob, { action: "enable", setupToken: `${setup.setupToken}x`, code: totpAt(setup.secret, currentStep()) })), 400);
    const enableStep = currentStep();
    const enabled = await call(twoFactorAction, "/api/auth/two-factor", bob, { action: "enable", setupToken: setup.setupToken, code: totpAt(setup.secret, enableStep) });
    assert.equal(enabled.status, 200);
    const { recoveryCodes } = await enabled.json();
    assert.equal(recoveryCodes.length, 10);
    // Turning it on signs out other sessions; the response carries a fresh one.
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", bob)), 401);
    const fresh = cookieFrom(enabled);
    assert.deepEqual(await (await call(twoFactorStatus, "/api/auth/two-factor", fresh)).json(), { enabled: true, enabledAt: (await (await call(twoFactorStatus, "/api/auth/two-factor", fresh)).json()).enabledAt, recoveryCodesLeft: 10 });

    // The password alone no longer gives a session.
    const first = await signIn({ username: "bob", password: USER_PASSWORD });
    const challenge = await first.json();
    assert.deepEqual([first.status, challenge.twoFactorRequired, cookieFrom(first)], [200, true, ""]);
    assert.equal(await status(signIn({ challenge: challenge.challenge, code: "000000" })), 401);
    // The code used to turn it on was consumed, so the same time step can't be replayed.
    assert.equal(await status(signIn({ challenge: challenge.challenge, code: totpAt(setup.secret, enableStep) })), 401);
    clearLoginFailures("direct-client");
    const next = totpAt(setup.secret, enableStep + 1);
    const verified = await signIn({ challenge: challenge.challenge, code: next });
    assert.equal(verified.status, 200);
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", cookieFrom(verified))), 200);
    // A challenge can't be reused once it has worked, and the same code can't sign in again.
    const again = (await (await signIn({ username: "bob", password: USER_PASSWORD })).json()).challenge;
    assert.equal(await status(signIn({ challenge: again, code: next })), 401);

    // A recovery code works once, with or without its dash.
    clearLoginFailures("direct-client");
    const recovery = await signIn({ challenge: again, code: recoveryCodes[0].replace("-", "").toUpperCase() });
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).recoveryCodesLeft, 9);
    const third = (await (await signIn({ username: "bob", password: USER_PASSWORD })).json()).challenge;
    assert.equal(await status(signIn({ challenge: third, code: recoveryCodes[0] })), 401);

    // A right code clears the account's wrong-code count.
    clearLoginFailures("direct-client");
    const reset = (await (await signIn({ username: "bob", password: USER_PASSWORD })).json()).challenge;
    assert.equal(await status(signIn({ challenge: reset, code: recoveryCodes[1] })), 200);

    // Each challenge allows five tries, after which the password is needed again.
    clearLoginFailures("direct-client");
    const limited = (await (await signIn({ username: "bob", password: USER_PASSWORD })).json()).challenge;
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await status(signIn({ challenge: limited, code: "000000" })), 401);
    clearLoginFailures("direct-client");
    assert.equal(await status(signIn({ challenge: limited, code: "000000" })), 401);
    const exhausted = await signIn({ challenge: limited, code: recoveryCodes[2] });
    assert.deepEqual([exhausted.status, (await exhausted.json()).code], [401, "CHALLENGE_EXPIRED"]);

    // Five wrong codes also lock the account's codes for a while, even on a fresh challenge and
    // even for a right code, so new challenges can't be used to keep guessing.
    clearLoginFailures("direct-client");
    const fresh2 = (await (await signIn({ username: "bob", password: USER_PASSWORD })).json()).challenge;
    const locked = await signIn({ challenge: fresh2, code: recoveryCodes[2] });
    assert.deepEqual([locked.status, (await locked.json()).code], [429, "TWO_FACTOR_LOCKED"]);
    clearLoginFailures("direct-client");
  });
});

test("sign-in attempts are counted as they start, so parallel requests can't exceed the limit", async () => {
  await withAccounts(async () => {
    clearLoginFailures("direct-client");
    const results = await Promise.all(Array.from({ length: 12 }, () => signIn({ username: "bob", password: "wrong-password-here" })));
    const statuses = results.map((response) => response.status);
    assert.equal(statuses.filter((code) => code === 401).length, 5);
    assert.equal(statuses.filter((code) => code === 429).length, 7);
    clearLoginFailures("direct-client");
  });
});

test("two-factor sign-in can be turned off, reset by the owner, and survives credential changes", async () => {
  await withAccounts(async ({ owner, bob, ids }) => {
    clearLoginFailures("direct-client");
    const bobTwoFactor = await enableTwoFactor(bob, USER_PASSWORD);
    const listed = (await (await call(usersList, "/api/users", owner)).json()).users.find((user: { id: string }) => user.id === ids.bob);
    assert.equal(listed.twoFactor, true);
    assert.equal(JSON.stringify(listed).includes(bobTwoFactor.secret), false);

    // Turning it off needs the password and a code.
    assert.equal(await status(call(twoFactorAction, "/api/auth/two-factor", bobTwoFactor.cookie, { action: "disable", currentPassword: USER_PASSWORD, code: "000000" })), 401);
    assert.equal(await status(call(twoFactorAction, "/api/auth/two-factor", bobTwoFactor.cookie, { action: "disable", currentPassword: "wrong-password-here", code: bobTwoFactor.recoveryCodes[0] })), 401);

    // The owner resets it for a lost phone: bob is signed out and signs in with a password alone.
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "resetTwoFactor", id: ids.bob })), 200);
    assert.equal(await status(call(listFs, "/api/fs?path=home/bob", bobTwoFactor.cookie)), 401);
    const plain = await signIn({ username: "bob", password: USER_PASSWORD });
    assert.deepEqual([plain.status, (await plain.json()).authenticated], [200, true]);
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "resetTwoFactor", id: ids.bob })), 409);
    // The owner's own can't be cleared through the reset, only turned off with a code.
    assert.equal(await status(call(usersAction, "/api/users", owner, { action: "resetTwoFactor", id: "owner" })), 400);

    // The owner's own two-factor sign-in is kept when they change their password.
    const ownerTwoFactor = await enableTwoFactor(owner, OWNER_PASSWORD);
    const changed = await call(preferences, "/api/auth/preferences", ownerTwoFactor.cookie, { currentPassword: OWNER_PASSWORD, newPassword: "another-owner-password" });
    assert.equal(changed.status, 200);
    assert.ok((await readCredentials()).twoFactor);
    const disabled = await call(twoFactorAction, "/api/auth/two-factor", cookieFrom(changed), { action: "disable", currentPassword: "another-owner-password", code: ownerTwoFactor.recoveryCodes[0] });
    assert.equal(disabled.status, 200);
    assert.equal((await readCredentials()).twoFactor, undefined);
    clearLoginFailures("direct-client");
  });
});

test("snapshots: everyone browses inside their folder, editors restore, only the owner manages them", async () => {
  await withAccounts(async ({ root, owner, bob, viewer }) => {
    const snapshotFolder = path.join(root, ".zfs", "snapshot", "s1");
    await fs.mkdir(path.join(snapshotFolder, "home", "bob", "docs"), { recursive: true });
    await fs.mkdir(path.join(snapshotFolder, "shared"), { recursive: true });
    await fs.writeFile(path.join(snapshotFolder, "home", "bob", "docs", "plan.txt"), "last week's plan");
    await fs.writeFile(path.join(snapshotFolder, "shared", "notice.txt"), "old notice");
    const snapshots = [{ name: "s1", creation: 1_700_000_000 }];
    setZfsRunner(async (args) => {
      if (args[0] === "list" && args.includes("filesystem")) return `pool/ct100\t${root}\n`;
      if (args[0] === "list") return snapshots.map((item) => `pool/ct100@${item.name}\t${item.creation}\t4096`).join("\n");
      if (args[0] === "snapshot") snapshots.push({ name: args[1].split("@")[1], creation: 1_800_000_000 });
      return "";
    });
    try {
      // Only the owner sees snapshots until the owner shares them.
      assert.deepEqual(await (await call(snapshotsInfo, "/api/fs/snapshots", viewer)).json(), { available: false });
      assert.equal(await status(call(snapshotDownload, "/api/fs/snapshots/download?snapshot=s1&path=shared/notice.txt", viewer)), 403);
      assert.equal(await status(call(snapshotsInfo, "/api/fs/snapshots?view=versions&path=home/bob/docs/plan.txt", bob)), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", bob, { action: "restore", snapshot: "s1", path: "home/bob/docs/plan.txt" })), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", bob, { action: "access", access: "everyone" })), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", owner, { action: "access", access: "editors" })), 200);
      assert.equal((await (await call(snapshotsInfo, "/api/fs/snapshots", bob)).json()).available, true);
      assert.equal((await (await call(snapshotsInfo, "/api/fs/snapshots", viewer)).json()).available, false);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", owner, { action: "access", access: "everyone" })), 200);

      const forViewer = await (await call(snapshotsInfo, "/api/fs/snapshots", viewer)).json();
      assert.deepEqual([forViewer.available, forViewer.snapshots[0].used, forViewer.schedule], [true, undefined, undefined]);
      const forOwner = await (await call(snapshotsInfo, "/api/fs/snapshots", owner)).json();
      assert.deepEqual([forOwner.snapshots[0].used, forOwner.schedule.frequency, forOwner.dataset, forOwner.access], [4096, "off", "pool/ct100", "everyone"]);

      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", bob, { action: "create" })), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", bob, { action: "schedule", schedule: { frequency: "daily", keep: 7 } })), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", owner, { action: "schedule", schedule: { frequency: "weekly", keep: 7 } })), 400);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", owner, { action: "create" })), 200);

      // Viewers download but can't restore; editors restore only inside their folder.
      assert.equal(await status(call(snapshotDownload, "/api/fs/snapshots/download?snapshot=s1&path=shared/notice.txt", viewer)), 200);
      assert.equal(await status(call(snapshotDownload, "/api/fs/snapshots/download?snapshot=s1&path=home/bob/docs/plan.txt", viewer)), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", viewer, { action: "restore", snapshot: "s1", path: "shared/notice.txt" })), 403);
      assert.equal(await status(call(snapshotsAction, "/api/fs/snapshots", bob, { action: "restore", snapshot: "s1", path: "shared/notice.txt" })), 403);
      const restored = await (await call(snapshotsAction, "/api/fs/snapshots", bob, { action: "restore", snapshot: "s1", path: "home/bob/docs/plan.txt" })).json();
      assert.equal(restored.job.status, "done");
      assert.match(restored.job.transferred[0].path, /^home\/bob\/docs\/plan \(restored \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.txt$/);
      assert.equal(await fs.readFile(path.join(root, "home", "bob", "docs", "plan.txt"), "utf8"), "bob's plan");
      assert.equal(await fs.readFile(path.join(root, restored.job.transferred[0].path), "utf8"), "last week's plan");

      const versions = await (await call(snapshotsInfo, "/api/fs/snapshots?view=versions&path=home/bob/docs/plan.txt", bob)).json();
      assert.deepEqual(versions.versions.map((version: { snapshot: string }) => version.snapshot), ["s1"]);
      assert.equal(await status(call(snapshotsInfo, "/api/fs/snapshots?view=browse&snapshot=s1&path=shared", bob)), 403);
    } finally {
      setZfsRunner(undefined as never);
    }
  });
});

test("only the owner scans for duplicates, and removing them moves copies to the trash", async () => {
  await withAccounts(async ({ root, owner, bob }) => {
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    await fs.writeFile(path.join(root, "shared", "one.bin"), content);
    await fs.writeFile(path.join(root, "home", "bob", "two.bin"), content);
    assert.equal(await status(call(duplicatesInfo, "/api/fs/duplicates", bob)), 403);
    assert.equal(await status(call(duplicatesAction, "/api/fs/duplicates", bob, { action: "scan", path: "home/bob" })), 403);
    assert.equal(await status(call(duplicatesAction, "/api/fs/duplicates", owner, { action: "scan", path: "", minBytes: 1024 * 1024 })), 200);
    await waitForDuplicateScan();
    const report = (await (await call(duplicatesInfo, "/api/fs/duplicates", owner)).json()).report;
    assert.equal(report.totalGroups, 1);
    assert.equal(await status(call(duplicatesAction, "/api/fs/duplicates", owner, { action: "trash", paths: ["shared/one.bin", "home/bob/two.bin"] })), 400);
    const trashed = await (await call(duplicatesAction, "/api/fs/duplicates", owner, { action: "trash", paths: ["home/bob/two.bin"] })).json();
    assert.equal(trashed.result.trashed.length, 1);
    assert.equal(trashed.report.totalGroups, 0);
    await assert.rejects(fs.lstat(path.join(root, "home", "bob", "two.bin")));
    assert.equal((await (await call(trashList, "/api/fs/trash", owner)).json()).items[0].name, "two.bin");
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

// A multipart upload of `files` (name and contents) with the given query.
function sendUpload(cookie: string, query: string, files: Array<{ name: string; body: string }>) {
  const boundary = "folder-upload-boundary";
  const body = files.map((file) => `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${file.body}\r\n`).join("") + `--${boundary}--\r\n`;
  return upload(new Request(`http://localhost/api/fs/upload?${query}`, { method: "POST", headers: { cookie, "x-filedude-request": "1", "content-type": `multipart/form-data; boundary=${boundary}` }, body }));
}

function makeFolder(cookie: string, query: string) {
  return upload(new Request(`http://localhost/api/fs/upload?${query}&createFolder=1`, { method: "POST", headers: { cookie, "x-filedude-request": "1", "content-type": "application/json" }, body: "{}" }));
}

test("a folder uploads with its structure, into a new folder each time", async () => {
  await withAccounts(async ({ root, bob }) => {
    const home = path.join(root, "home", "bob");
    const first = await makeFolder(bob, "path=home/bob&folder=Photos&unique=1");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).folder, "home/bob/Photos");
    // The same folder again goes into a new one rather than merging.
    assert.equal((await (await makeFolder(bob, "path=home/bob&folder=Photos&unique=1")).json()).folder, "home/bob/Photos (1)");
    const sent = await sendUpload(bob, "path=home/bob&folder=Photos/2024/summer", [{ name: "beach.jpg", body: "sand" }]);
    assert.equal(sent.status, 200);
    assert.deepEqual((await sent.json()).uploaded, ["home/bob/Photos/2024/summer/beach.jpg"]);
    assert.equal(await fs.readFile(path.join(home, "Photos/2024/summer/beach.jpg"), "utf8"), "sand");
    // Existing folders are reused and clashing files get new names.
    assert.equal((await sendUpload(bob, "path=home/bob&folder=Photos/2024/summer", [{ name: "beach.jpg", body: "more sand" }])).status, 200);
    assert.equal(await fs.readFile(path.join(home, "Photos/2024/summer/beach (1).jpg"), "utf8"), "more sand");
    // Empty folders are made too.
    assert.equal((await makeFolder(bob, "path=home/bob&folder=Photos/empty/inner")).status, 200);
    assert.ok((await fs.stat(path.join(home, "Photos/empty/inner"))).isDirectory());
  });
});

test("folder uploads stay inside the account's folder and never follow links", async () => {
  await withAccounts(async ({ root, bob, viewer }) => {
    const home = path.join(root, "home", "bob");
    await fs.symlink("../alice", path.join(home, "to-alice"));
    for (const folder of ["..", "../alice", "a/../../alice", ".filedude", "a//b", "to-alice", "to-alice/x", "docs/plan.txt", "docs/plan.txt/x", Array.from({ length: 40 }, () => "d").join("/")]) {
      const made = await makeFolder(bob, `path=home/bob&folder=${encodeURIComponent(folder)}`);
      assert.ok(made.status >= 400 && made.status < 500, `${folder}: ${made.status}`);
      const sent = await sendUpload(bob, `path=home/bob&folder=${encodeURIComponent(folder)}`, [{ name: "x.txt", body: "x" }]);
      assert.ok(sent.status >= 400 && sent.status < 500, `${folder}: ${sent.status}`);
    }
    assert.deepEqual((await fs.readdir(path.join(root, "home", "alice"))).sort(), ["diary.txt"]);
    assert.ok(!(await fs.readdir(home)).includes("a"));
    // Viewers can't upload folders, and a folder name needs a folder.
    assert.equal((await makeFolder(viewer, "path=shared&folder=New&unique=1")).status, 403);
    assert.equal((await makeFolder(bob, "path=home/bob")).status, 400);
  });
});

test("folder uploads refuse overlong paths, step past links, and record every folder they make", async () => {
  await withAccounts(async ({ root, bob }) => {
    const home = path.join(root, "home", "bob");
    // Too long as a whole, though each name is fine: refused before anything is made.
    const long = Array.from({ length: 20 }, () => "n".repeat(250)).join("/");
    assert.equal((await makeFolder(bob, `path=home/bob&folder=${long}`)).status, 400);
    assert.ok(!(await fs.readdir(home)).includes("n".repeat(250)));
    // A link where the top folder would go just means the name is taken.
    await fs.symlink("/etc", path.join(home, "Photos"));
    const made = await makeFolder(bob, "path=home/bob&folder=Photos&unique=1");
    assert.equal(made.status, 200);
    assert.equal((await made.json()).folder, "home/bob/Photos (1)");
    // Folders made on the way are recorded under their real names, even when the upload then fails.
    const failed = await upload(new Request("http://localhost/api/fs/upload?path=home/bob&folder=s1/s2", { method: "POST", headers: { cookie: bob, "x-filedude-request": "1", "content-type": "text/plain" }, body: "not multipart" }));
    assert.equal(failed.status, 400);
    const log = await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8");
    const created = log.trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.event === "fs.create").map((entry) => `${entry.path}/${entry.name}`);
    assert.deepEqual(created, ["home/bob/Photos (1)", "home/bob/s1", "home/bob/s1/s2"]);
  });
});

// As root on Linux (like the service): new folders and files take the owner of the folder they're in.
const asRoot = process.platform === "linux" && process.getuid?.() === 0;

test("an editor's uploaded folders take the owner of the folder each lands in", { skip: !asRoot && "needs root on Linux" }, async () => {
  await withAccounts(async ({ root, bob }) => {
    const home = path.join(root, "home", "bob");
    await fs.chown(home, 1000, 1000);
    await fs.mkdir(path.join(home, "carol"));
    await fs.chown(path.join(home, "carol"), 1001, 1001);
    assert.equal((await sendUpload(bob, "path=home/bob&folder=carol/deep/er", [{ name: "f.txt", body: "x" }])).status, 200);
    for (const item of ["carol/deep", "carol/deep/er", "carol/deep/er/f.txt"]) assert.equal((await fs.stat(path.join(home, item))).uid, 1001, item);
    assert.equal((await sendUpload(bob, "path=home/bob&folder=mine/sub", [{ name: "g.txt", body: "y" }])).status, 200);
    for (const item of ["mine", "mine/sub", "mine/sub/g.txt"]) assert.equal((await fs.stat(path.join(home, item))).uid, 1000, item);
  });
});
