import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cancelLinkUploads } from "../lib/chunked-uploads";
import { config } from "../lib/config";
import { readCopyJournal } from "../lib/copy-journal";
import { createShare, createUploadLink, listShares, resolveShareToken, uploadRoom, type UploadShare } from "../lib/shares";
import { GET as status, POST as action, PUT as piece } from "../app/s/[token]/upload/pieces/route";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-link-pieces-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled, maxUploadBytes: config.maxUploadBytes };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "link-pieces-test-session-secret-with-32-characters", sharingEnabled: true, maxUploadBytes: 64 * 1024 * 1024 });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.replace(/^\/s\//, "");
const headers = (extra: Record<string, string> = {}) => ({ host: "localhost", origin: "http://localhost", "x-filedude-request": "1", ...extra });
const context = (token: string) => ({ params: Promise.resolve({ token }) });

async function json(response: Promise<Response>) {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as Record<string, unknown> };
}

const post = (token: string, body: Record<string, unknown>) =>
  json(action(new Request(`http://localhost/s/${token}/upload/pieces`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) }), context(token)));
const send = (token: string, id: unknown, offset: number, data: Buffer) =>
  json(piece(new Request(`http://localhost/s/${token}/upload/pieces?id=${id}&offset=${offset}`, { method: "PUT", headers: headers({ "content-length": String(data.length) }), body: new Uint8Array(data) }), context(token)));
const where = (token: string, id: unknown) => json(status(new Request(`http://localhost/s/${token}/upload/pieces?id=${id}`, { headers: headers() }), context(token)));

test("a stranger sends a large file through an upload link in pieces, within the link's room", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "inbox", "_holiday.mov"), "the owner's");
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, null);
    const token = tokenOf(link.url);
    const data = crypto.randomBytes(2 * 1024 * 1024 + 7);
    const started = await post(token, { action: "start", name: ".holiday.mov", size: data.length, from: "Sam" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const id = started.body.id;
    assert.ok((await fs.readdir(path.join(root, "inbox"))).some((name) => name.endsWith("(uploading)")));
    // The room is promised as soon as it starts.
    assert.equal(uploadRoom((await resolveShareToken(token)) as UploadShare).bytes, 10 * 1024 * 1024 - data.length);

    const size = 1024 * 1024;
    for (let offset = 0; offset < data.length; offset += size) assert.equal((await send(token, id, offset, data.subarray(offset, offset + size))).status, 200);
    assert.deepEqual((await where(token, id)).body, { received: data.length, size: data.length });
    const done = await post(token, { action: "finish", id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    // The stored name isn't returned; a hidden name became visible and a taken one got a number.
    assert.equal(done.body.name, undefined);
    const names = await fs.readdir(path.join(root, "inbox"));
    assert.deepEqual(names.sort(), ["_holiday (1).mov", "_holiday.mov"]);
    assert.ok((await fs.readFile(path.join(root, "inbox", "_holiday (1).mov"))).equals(data));
    assert.equal((await fs.stat(path.join(root, "inbox", "_holiday (1).mov"))).mode & 0o777, 0o640);
    assert.deepEqual(await readCopyJournal(), []);
    const [stored] = await listShares();
    assert.equal(stored.uploadedFiles, 1);
    assert.equal(stored.uploadedBytes, data.length);
    assert.match(await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8"), /"event":"share\.upload".*"from":"Sam","pieces":true/);
  });
});

test("link uploads in pieces keep to the link's limits and the link itself", async () => {
  await withRoot(async (root) => {
    const link = await createUploadLink("inbox", 24, 3 * 1024 * 1024, 2);
    const token = tokenOf(link.url);
    assert.equal((await post(token, { action: "start", name: "huge.bin", size: 4 * 1024 * 1024 })).status, 413);
    const first = await post(token, { action: "start", name: "a.bin", size: 2 * 1024 * 1024 });
    assert.equal(first.status, 200);
    // The second can't be promised more than is left.
    assert.equal((await post(token, { action: "start", name: "b.bin", size: 2 * 1024 * 1024 })).status, 413);
    const second = await post(token, { action: "start", name: "b.bin", size: 1024 });
    assert.equal(second.status, 200);
    // Two files allowed, both promised.
    assert.equal((await post(token, { action: "start", name: "c.bin", size: 10 })).status, 409);
    // Cancelling gives the room back and removes the placeholder.
    assert.equal((await post(token, { action: "cancel", id: second.body.id })).status, 200);
    assert.equal(uploadRoom((await resolveShareToken(token)) as UploadShare).files, 1);

    // An upload belongs to its link: another link, or a download link, can't touch it.
    const other = await createUploadLink("inbox", 24, 3 * 1024 * 1024, null);
    assert.equal((await send(tokenOf(other.url), first.body.id, 0, Buffer.from("x"))).status, 404);
    assert.equal((await where(tokenOf(other.url), first.body.id)).status, 404);
    const downloadLink = await createShare("inbox", 24, null);
    assert.equal((await post(tokenOf(downloadLink.url), { action: "start", name: "d.bin", size: 10 })).status, 404);
    assert.equal((await send(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, first.body.id, 0, Buffer.from("x"))).status, 404);

    // Revoking the link stops its uploads.
    await cancelLinkUploads(link.id);
    assert.equal((await send(token, first.body.id, 0, Buffer.from("x"))).status, 404);
    assert.deepEqual(await fs.readdir(path.join(root, "inbox")), []);
    assert.deepEqual(await readCopyJournal(), []);
  });
});

test("starting many link uploads at the same moment still keeps to the limits", async () => {
  await withRoot(async (root) => {
    const link = await createUploadLink("inbox", 24, 1024 * 1024 * 1024, null);
    const token = tokenOf(link.url);
    const results = await Promise.all(Array.from({ length: 60 }, (_, index) => post(token, { action: "start", name: `f${index}.bin`, size: 1024 })));
    assert.equal(results.filter((result) => result.status === 200).length, 3);
    assert.equal((await fs.readdir(path.join(root, "inbox"))).length, 3);
    await cancelLinkUploads(link.id);
    assert.deepEqual(await fs.readdir(path.join(root, "inbox")), []);
    assert.equal(uploadRoom((await resolveShareToken(token)) as UploadShare).bytes, 1024 * 1024 * 1024);
  });
});

test("one sender can only run a few link uploads at once", async () => {
  await withRoot(async () => {
    const links = await Promise.all([1, 2].map(() => createUploadLink("inbox", 24, 10 * 1024 * 1024, null)));
    const [one, two] = links.map((link) => tokenOf(link.url));
    for (const name of ["1", "2", "3"]) assert.equal((await post(one, { action: "start", name, size: 10 })).status, 200);
    // At most three per link, and three per sender across links.
    assert.equal((await post(one, { action: "start", name: "4", size: 10 })).status, 503);
    assert.equal((await post(two, { action: "start", name: "5", size: 10 })).status, 429);
    await cancelLinkUploads(links[0].id);
    assert.equal((await post(two, { action: "start", name: "5", size: 10 })).status, 200);
    await cancelLinkUploads(links[1].id);
  });
});
