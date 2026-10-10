import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { createUser } from "../lib/users";
import { runInScope } from "../lib/scope";
import { continueWatching, flushWatching, forgetAccountWatching, forgetWatching, saveWatchPosition, watchingIn, watchPosition } from "../lib/watching";
import { GET as watching, POST as watchingAction } from "../app/api/watching/route";
import { POST as usersAction } from "../app/api/users/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (context: { root: string; state: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-watching-")));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  for (const folder of ["tv/Show", "home/bob", "home/alice"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const file of ["tv/Show/e1.mkv", "tv/Show/e2.mkv", "tv/Show/e3.mkv", "tv/Show/notes.txt", "movie.mp4", "home/bob/clip.mp4", "home/alice/clip.mp4"]) await fs.writeFile(path.join(root, file), "video");
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  Object.assign(config, { root, stateDir: state, passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("watching-test-password", salt)).toString("base64url")}`, sessionSecret: "watching-test-session-secret-with-more-than-32-chars" });
  try {
    return await run({ root, state });
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("positions are kept per video, a finished video is marked watched, and a just-started one isn't kept", async () => {
  await withRoot(async ({ state }) => {
    // Under 30 seconds in isn't worth carrying on from.
    assert.equal(await saveWatchPosition("owner", "tv/Show/e1.mkv", 12, 2400), null);
    assert.equal(await watchPosition("owner", "tv/Show/e1.mkv"), null);
    const saved = await saveWatchPosition("owner", "tv/Show/e1.mkv", 600.4, 2400.2);
    assert.deepEqual([saved?.position, saved?.duration, saved?.watched], [600, 2400, false]);
    assert.equal((await watchPosition("owner", "/tv/Show/e1.mkv"))?.position, 600);
    // Within two minutes of the end counts as watched, and starts from the beginning next time.
    const finished = await saveWatchPosition("owner", "tv/Show/e2.mkv", 2300, 2400);
    assert.deepEqual([finished?.position, finished?.watched], [0, true]);
    // Watching a watched video again from the start keeps it marked watched.
    assert.equal((await saveWatchPosition("owner", "tv/Show/e2.mkv", 5, 2400))?.watched, true);
    await saveWatchPosition("owner", "movie.mp4", 3000, 7200);

    const list = await continueWatching("owner");
    assert.deepEqual(list.map((item) => item.path), ["movie.mp4", "tv/Show/e1.mkv"]);
    assert.deepEqual([list[1].name, list[1].size, list[1].mime], ["e1.mkv", 5, "video/x-matroska"]);
    const marks = await watchingIn("owner", "tv/Show");
    assert.deepEqual(marks.map((item) => [item.path, item.watched]).sort(), [["tv/Show/e1.mkv", false], ["tv/Show/e2.mkv", true]]);
    assert.deepEqual((await watchingIn("owner", "")).map((item) => item.path), ["movie.mp4"]);
    // Another account has its own.
    assert.deepEqual(await continueWatching("someone-else"), []);
    // Kept in memory, then written out.
    await flushWatching();
    assert.equal((await fs.stat(path.join(state, "watching.json"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(path.join(state, "watching.json"), "utf8")).owner.length, 3);
  });
});

test("only videos, sensible positions, and places the account can reach are accepted", async () => {
  await withRoot(async () => {
    await assert.rejects(saveWatchPosition("owner", "tv/Show/notes.txt", 100, 200), /Only videos/);
    await assert.rejects(saveWatchPosition("owner", "", 100, 200), /Only videos/);
    await assert.rejects(saveWatchPosition("owner", 42, 100, 200), /Choose a video/);
    await assert.rejects(saveWatchPosition("owner", "x".repeat(5000) + ".mp4", 100, 200), /Choose a video/);
    for (const [position, duration] of [[Number.NaN, 100], [-1, 100], [100, -1], [2e6, 3e6], ["100", Infinity], [null, "x"]]) {
      await assert.rejects(saveWatchPosition("owner", "movie.mp4", position, duration), /position is invalid/, `${position} ${duration}`);
    }
    await assert.rejects(saveWatchPosition("owner", "../outside.mp4", 100, 200));
    // Only videos that are there (and missing folders are just "not there", not errors).
    await assert.rejects(saveWatchPosition("owner", "tv/Show/e9.mkv", 100, 200), (error: Error & { status?: number }) => error.status === 404);
    await assert.rejects(saveWatchPosition("owner", "tv/Nope/e1.mkv", 100, 200), (error: Error & { status?: number }) => error.status === 404);
    await assert.rejects(saveWatchPosition("owner", `tv/${"n".repeat(300)}.mkv`, 100, 200), (error: Error & { status?: number }) => error.status === 404);
    await assert.rejects(saveWatchPosition("owner", "tv/Show", 100, 200), /Only videos/);
    assert.equal(await watchPosition("owner", "tv/Nope/e1.mkv").catch((error: Error & { status?: number }) => error.status), 404);
    assert.equal(await watchPosition("owner", "tv/Show/e9.mkv"), null);
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.ok(await saveWatchPosition("bob", "home/bob/clip.mp4", 100, 2000));
      await assert.rejects(saveWatchPosition("bob", "home/alice/clip.mp4", 100, 2000), /outside your folder/);
      await assert.rejects(watchPosition("bob", "home/alice/clip.mp4"), /outside your folder/);
    });
  });
});

test("the list leaves out videos since moved, deleted, or outside the account's folder now", async () => {
  await withRoot(async ({ root }) => {
    await saveWatchPosition("bob", "home/bob/clip.mp4", 100, 2000);
    await saveWatchPosition("bob", "tv/Show/e3.mkv", 100, 2000);
    await saveWatchPosition("bob", "movie.mp4", 100, 2000);
    await fs.rm(path.join(root, "movie.mp4"));
    assert.deepEqual((await continueWatching("bob")).map((item) => item.path), ["tv/Show/e3.mkv", "home/bob/clip.mp4"]);
    // The account's folder narrowed to its home: only what's in there now.
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.deepEqual((await continueWatching("bob")).map((item) => item.path), ["home/bob/clip.mp4"]);
      assert.deepEqual(await watchingIn("bob", "tv/Show"), []);
    });
  });
});

test("a video can be forgotten, or all of them, and the newest 300 are kept", async () => {
  await withRoot(async ({ root }) => {
    await saveWatchPosition("owner", "tv/Show/e1.mkv", 100, 2000);
    await saveWatchPosition("owner", "tv/Show/e3.mkv", 100, 2000);
    await forgetWatching("owner", "tv/Show/e1.mkv");
    assert.equal(await watchPosition("owner", "tv/Show/e1.mkv"), null);
    assert.ok(await watchPosition("owner", "tv/Show/e3.mkv"));
    await forgetWatching("owner");
    assert.deepEqual(await continueWatching("owner"), []);

    await fs.mkdir(path.join(root, "many"));
    for (let index = 0; index < 305; index += 1) await fs.writeFile(path.join(root, "many", `v${index}.mp4`), "v");
    for (let index = 0; index < 305; index += 1) await saveWatchPosition("owner", `many/v${index}.mp4`, 100, 2000);
    const kept = await watchingIn("owner", "many");
    assert.equal(kept.length, 300);
    assert.ok(!kept.some((item) => item.path === "many/v0.mp4"));
    assert.ok(kept.some((item) => item.path === "many/v304.mp4"));
  });
});

test("saves in quick succession are recorded once, and nothing is written until it's time", async () => {
  await withRoot(async ({ state }) => {
    await saveWatchPosition("owner", "movie.mp4", 100, 7200);
    for (let second = 101; second < 200; second += 1) await saveWatchPosition("owner", "movie.mp4", second, 7200);
    assert.equal((await watchPosition("owner", "movie.mp4"))?.position, 100);
    await assert.rejects(fs.stat(path.join(state, "watching.json")));
    // Finishing it is recorded straight away.
    assert.equal((await saveWatchPosition("owner", "movie.mp4", 7190, 7200))?.watched, true);
    await flushWatching();
    assert.equal(JSON.parse(await fs.readFile(path.join(state, "watching.json"), "utf8")).owner[0].watched, true);
  });
});

test("a damaged file is kept aside, odd entries are ignored, and removed accounts' history isn't written", async () => {
  await withRoot(async ({ state }) => {
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "watching.json"), JSON.stringify({ owner: [{ path: "movie.mp4", position: 100, duration: 7200, watched: false, updatedAt: "2026-01-01T00:00:00Z" }, { path: 5 }], gone: "not a list", ghost: [{ path: "movie.mp4", position: 100, duration: 7200, watched: false, updatedAt: "2026-01-01T00:00:00Z" }] }));
    assert.deepEqual((await continueWatching("owner")).map((item) => item.path), ["movie.mp4"]);
    assert.deepEqual(await continueWatching("gone"), []);
    // "ghost" isn't an account, so its history goes when the file is next written.
    await saveWatchPosition("owner", "tv/Show/e1.mkv", 100, 2000);
    await flushWatching();
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(state, "watching.json"), "utf8"))), ["owner"]);
  });
  await withRoot(async ({ state }) => {
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "watching.json"), "{\"owner\": [tor");
    assert.deepEqual(await continueWatching("owner"), []);
    assert.equal(await fs.readFile(path.join(state, "watching.json.bad"), "utf8"), "{\"owner\": [tor");
  });
});

test("audiobooks are remembered like videos, songs aren't", async () => {
  await withRoot(async ({ root }) => {
    await fs.mkdir(path.join(root, "books", "Novel"), { recursive: true });
    for (const file of ["books/Novel/Novel.m4b", "books/Novel/Part 02.mp3", "song.mp3"]) await fs.writeFile(path.join(root, file), "audio");
    assert.equal((await saveWatchPosition("owner", "books/Novel/Novel.m4b", 1800, 36000))?.position, 1800);
    assert.equal((await saveWatchPosition("owner", "books/Novel/Part 02.mp3", 300, 2400))?.position, 300);
    // A four-minute song isn't worth carrying on from.
    assert.equal(await saveWatchPosition("owner", "song.mp3", 60, 240), null);
    const list = await continueWatching("owner");
    assert.deepEqual(list.map((item) => [item.path, item.mime]), [["books/Novel/Part 02.mp3", "audio/mpeg"], ["books/Novel/Novel.m4b", "audio/mp4"]]);
    assert.equal((await saveWatchPosition("owner", "books/Novel/Novel.m4b", 35990, 36000))?.watched, true);
  });
});

test("the API is per account, needs a signed-in request, and a removed account's history goes", async () => {
  await withRoot(async () => {
    const credentials = await getCredentials();
    const owner = `fd_session=${createSession(credentials.username, credentials.version)}`;
    const bob = await createUser({ username: "bob", password: "bob-test-password-long", role: "viewer", root: "home/bob" });
    const bobCookie = `fd_session=${createSession("bob", 1, bob.id)}`;
    const call = (handler: (request: Request) => Promise<Response>, url: string, cookie: string, body?: unknown, headers: Record<string, string> = { "x-filedude-request": "1" }) =>
      handler(new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json", ...headers }) }, body: body === undefined ? undefined : JSON.stringify(body) }));

    assert.equal((await call(watching, "/api/watching", "")).status, 401);
    assert.equal((await call(watchingAction, "/api/watching", bobCookie, { action: "save", path: "home/bob/clip.mp4", position: 300, duration: 1800 }, {})).status, 403);
    assert.equal((await call(watchingAction, "/api/watching", bobCookie, { action: "save", path: "home/bob/clip.mp4", position: 300, duration: 1800 })).status, 200);
    assert.equal((await call(watchingAction, "/api/watching", bobCookie, { action: "save", path: "home/alice/clip.mp4", position: 300, duration: 1800 })).status, 403);
    assert.equal((await call(watchingAction, "/api/watching", bobCookie, { action: "nonsense" })).status, 400);
    const bobs = await (await call(watching, "/api/watching", bobCookie)).json() as { entries: Array<{ path: string; position: number }> };
    assert.deepEqual(bobs.entries.map((item) => [item.path, item.position]), [["home/bob/clip.mp4", 300]]);
    assert.equal(((await (await call(watching, "/api/watching?path=home/bob/clip.mp4", bobCookie)).json()) as { entry: { position: number } }).entry.position, 300);
    assert.equal(((await (await call(watching, "/api/watching?folder=home/bob", bobCookie)).json()) as { entries: unknown[] }).entries.length, 1);
    // The owner's list is the owner's own.
    assert.deepEqual(((await (await call(watching, "/api/watching", owner)).json()) as { entries: unknown[] }).entries, []);

    assert.equal((await call(usersAction, "/api/users", owner, { action: "delete", id: bob.id })).status, 200);
    assert.equal(await watchPosition(bob.id, "home/bob/clip.mp4"), null);
    await forgetAccountWatching("nobody");
  });
});
