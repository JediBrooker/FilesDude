import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { readCopyJournal } from "../lib/copy-journal";
import { getCredentials } from "../lib/credentials";
import { createUser } from "../lib/users";
import { GET as status, POST as action, PUT as piece } from "../app/api/fs/upload/chunks/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (context: { root: string; owner: string; bob: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-chunks-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "home", "bob"), { recursive: true });
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, maxUploadBytes: config.maxUploadBytes };
  Object.assign(config, {
    root,
    stateDir: path.join(base, "state"),
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("chunk-test-password", salt)).toString("base64url")}`,
    sessionSecret: "chunk-test-session-secret-with-more-than-32-characters",
    maxUploadBytes: 8 * 1024 * 1024,
  });
  try {
    const credentials = await getCredentials();
    const bob = await createUser({ username: "bob", password: "bob-test-password-long", role: "editor", root: "home/bob" });
    return await run({ root, owner: `fd_session=${createSession(credentials.username, credentials.version)}`, bob: `fd_session=${createSession("bob", 1, bob.id)}` });
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const headers = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, host: "localhost", origin: "http://localhost", "x-filedude-request": "1", ...extra });

async function json(response: Promise<Response>) {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as Record<string, unknown> };
}

const start = (cookie: string, query: string, name: string, size: number) =>
  json(action(new Request(`http://localhost/api/fs/upload/chunks?${query}`, { method: "POST", headers: headers(cookie, { "content-type": "application/json" }), body: JSON.stringify({ action: "start", name, size }) })));
const finish = (cookie: string, id: unknown, kind = "finish") =>
  json(action(new Request("http://localhost/api/fs/upload/chunks", { method: "POST", headers: headers(cookie, { "content-type": "application/json" }), body: JSON.stringify({ action: kind, id }) })));
const send = (cookie: string, id: unknown, offset: number, data: Buffer) =>
  json(piece(new Request(`http://localhost/api/fs/upload/chunks?id=${id}&offset=${offset}`, { method: "PUT", headers: headers(cookie, { "content-type": "application/octet-stream", "content-length": String(data.length) }), body: new Uint8Array(data) })));
const where = (cookie: string, id: unknown) => json(status(new Request(`http://localhost/api/fs/upload/chunks?id=${id}`, { headers: headers(cookie) })));

test("a large file arrives in pieces under a placeholder and then takes its real name", async () => {
  await withRoot(async ({ root, owner }) => {
    await fs.writeFile(path.join(root, "movie.mkv"), "the owner's movie");
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const started = await start(owner, "path=&batch=batch-test-1", "movie.mkv", data.length);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const id = started.body.id;
    assert.ok((await fs.readdir(root)).includes("movie.mkv (uploading)"));
    assert.equal((await fs.stat(path.join(root, "movie.mkv (uploading)"))).mode & 0o777, 0o600);
    assert.equal((await readCopyJournal()).length, 1);

    const size = 1024 * 1024;
    assert.equal((await send(owner, id, 0, data.subarray(0, size))).body.received, size);
    // A piece that isn't the next one is refused, saying where to carry on.
    const skipped = await send(owner, id, size * 2, data.subarray(size * 2, size * 3));
    assert.equal(skipped.status, 409);
    assert.equal(skipped.body.received, size);
    const early = await finish(owner, id);
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "UPLOAD_INCOMPLETE");
    for (let offset = size; offset < data.length; offset += size) assert.equal((await send(owner, id, offset, data.subarray(offset, offset + size))).status, 200);
    assert.deepEqual((await where(owner, id)).body, { received: data.length, size: data.length });
    // Nothing past the end.
    assert.equal((await send(owner, id, data.length, Buffer.from("x"))).status, 400);

    const done = await finish(owner, id);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.uploaded, ["movie (1).mkv"]);
    assert.ok((await fs.readFile(path.join(root, "movie (1).mkv"))).equals(data));
    assert.equal(await fs.readFile(path.join(root, "movie.mkv"), "utf8"), "the owner's movie");
    assert.equal((await fs.stat(path.join(root, "movie (1).mkv"))).mode & 0o777, 0o640);
    assert.ok(!(await fs.readdir(root)).includes("movie.mkv (uploading)"));
    assert.deepEqual(await readCopyJournal(), []);
    assert.match(await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8"), /"event":"fs\.upload".*"movie \(1\)\.mkv".*"batch":"batch-test-1","pieces":true/);
    // A finished upload is gone.
    assert.equal((await where(owner, id)).status, 404);
  });
});

test("uploads in pieces stay within the account's folder, limits, and own uploads", async () => {
  await withRoot(async ({ root, owner, bob }) => {
    assert.equal((await start(owner, "path=", "huge.bin", 9 * 1024 * 1024)).status, 413);
    assert.equal((await start(owner, "path=", ".filedude", 10)).status, 403);
    assert.equal((await start(bob, "path=", "escape.bin", 10)).status, 403);

    const mine = await start(bob, "path=home/bob&folder=Album/2024", "photo.raw", 6);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    // Someone else's upload can't be seen, written to, finished, or cancelled.
    assert.equal((await where(owner, mine.body.id)).status, 404);
    assert.equal((await send(owner, mine.body.id, 0, Buffer.from("hacked"))).status, 404);
    assert.equal((await finish(owner, mine.body.id)).status, 404);
    assert.equal((await finish(owner, mine.body.id, "cancel")).status, 404);
    assert.equal((await send(bob, mine.body.id, 0, Buffer.from("pixels"))).status, 200);
    assert.deepEqual((await finish(bob, mine.body.id)).body.uploaded, ["home/bob/Album/2024/photo.raw"]);
    assert.equal(await fs.readFile(path.join(root, "home", "bob", "Album", "2024", "photo.raw"), "utf8"), "pixels");

    // A piece must come with its length, and no more than 64 MB.
    const other = await start(owner, "path=", "other.bin", 100);
    const noLength = await piece(new Request(`http://localhost/api/fs/upload/chunks?id=${other.body.id}&offset=0`, { method: "PUT", headers: headers(owner), body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); } }), duplex: "half" } as RequestInit));
    assert.equal(noLength.status, 413);
    // A piece cut off part-way is taken back, so the upload carries on from the same point.
    const cut = await piece(new Request(`http://localhost/api/fs/upload/chunks?id=${other.body.id}&offset=0`, { method: "PUT", headers: headers(owner, { "content-length": "50" }), body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20).fill(7)); controller.close(); } }), duplex: "half" } as RequestInit));
    assert.equal(cut.status, 400);
    assert.equal((await where(owner, other.body.id)).body.received, 0);
    assert.equal((await fs.stat(path.join(root, "other.bin (uploading)"))).size, 0);
    assert.equal((await send(owner, other.body.id, 0, Buffer.alloc(50, 1))).body.received, 50);
    // Cancelling removes the placeholder.
    assert.equal((await finish(owner, other.body.id, "cancel")).status, 200);
    assert.ok(!(await fs.readdir(root)).includes("other.bin (uploading)"));
    assert.deepEqual(await readCopyJournal(), []);
  });
});

test("an upload whose placeholder was swapped for something else isn't given a name", async () => {
  await withRoot(async ({ root, owner }) => {
    const started = await start(owner, "path=", "report.pdf", 4);
    assert.equal((await send(owner, started.body.id, 0, Buffer.from("real"))).status, 200);
    await fs.writeFile(path.join(root, "secret.txt"), "secret");
    await fs.rm(path.join(root, "report.pdf (uploading)"));
    await fs.link(path.join(root, "secret.txt"), path.join(root, "report.pdf (uploading)"));
    const done = await finish(owner, started.body.id);
    assert.equal(done.status, 409);
    assert.equal(done.body.code, "PATH_CHANGED");
    assert.ok(!(await fs.readdir(root)).includes("report.pdf"));
    assert.equal((await fs.stat(path.join(root, "secret.txt"))).mode & 0o777, (await fs.stat(path.join(root, "report.pdf (uploading)"))).mode & 0o777);
    assert.equal(await fs.readFile(path.join(root, "secret.txt"), "utf8"), "secret");
  });
});
