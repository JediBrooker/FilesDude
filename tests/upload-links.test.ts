import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createShare, createUploadLink, listShares, recordShareDownload, reserveUpload, revokeShare } from "../lib/shares";
import { GET as download } from "../app/s/[token]/download/route";
import { POST as upload } from "../app/s/[token]/upload/route";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-upload-links-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled, maxUploadBytes: config.maxUploadBytes };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "upload-link-test-session-secret-with-32-characters", sharingEnabled: true, maxUploadBytes: 4 * 1024 * 1024 });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.replace(/^\/s\//, "");

async function send(token: string, files: Array<{ name: string; content: string | Buffer }>, options: { from?: string; headers?: Record<string, string>; field?: string } = {}) {
  const form = new FormData();
  if (options.from !== undefined) form.append("from", options.from);
  for (const file of files) form.append(options.field ?? "file", new Blob([typeof file.content === "string" ? file.content : new Uint8Array(file.content)]), file.name);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers = { host: "localhost", origin: "http://localhost", "x-filedude-request": "1", "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length), ...options.headers };
  const response = await upload(new Request(`http://localhost/s/${token}/upload`, { method: "POST", headers, body }), { params: Promise.resolve({ token }) });
  return { status: response.status, body: (await response.json()) as { ok?: boolean; code?: string; error?: string; name?: string } };
}

const inbox = async (root: string) => (await fs.readdir(path.join(root, "inbox"))).sort();

test("anyone with an upload link can add files to its folder, never replacing anything", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "inbox", "report.pdf"), "the owner's report");
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, null);
    assert.equal(link.kind, "upload");
    const token = tokenOf(link.url);

    const first = await send(token, [{ name: "photo.jpg", content: "jpeg bytes" }], { from: "Sam" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // The response never says what the file was stored as.
    assert.equal(first.body.name, undefined);
    const taken = await send(token, [{ name: "report.pdf", content: "a stranger's report" }]);
    assert.equal(taken.status, 200);
    assert.equal(await fs.readFile(path.join(root, "inbox", "report.pdf"), "utf8"), "the owner's report");
    assert.equal(await fs.readFile(path.join(root, "inbox", "report (1).pdf"), "utf8"), "a stranger's report");
    // Path parts are dropped and invisible characters replaced.
    assert.equal((await send(token, [{ name: "../../escape.txt", content: "x" }])).status, 200);
    assert.equal((await send(token, [{ name: `invoice\u202Etxt.exe`, content: "x" }])).status, 200);
    assert.equal((await send(token, [{ name: "Café 写真.jpg", content: "x" }])).status, 200);
    assert.deepEqual(await inbox(root), ["Café 写真.jpg", "escape.txt", "invoice_txt.exe", "photo.jpg", "report (1).pdf", "report.pdf"]);
    assert.equal((await send(token, [{ name: ".filedude", content: "x" }])).status, 403);

    const [stored] = await listShares();
    assert.equal(stored.uploadedFiles, 5);
    assert.equal(stored.uploadedBytes, "jpeg bytes".length + "a stranger's report".length + 3);
    const audit = await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8");
    assert.match(audit, /"event":"share\.upload".*"name":"photo\.jpg".*"from":"Sam"/);
  });
});

test("an upload link never shows or downloads the folder, and only takes requests from its page", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "inbox", "secret.txt"), "secret");
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, null);
    const token = tokenOf(link.url);
    const response = await download(new Request(`http://localhost/s/${token}/download`), { params: Promise.resolve({ token }) });
    assert.equal(response.status, 404);
    assert.equal(await recordShareDownload(link.id), false);

    assert.equal((await send(token, [{ name: "a.txt", content: "a" }], { headers: { "x-filedude-request": "" } })).status, 403);
    assert.equal((await send(token, [{ name: "a.txt", content: "a" }], { headers: { origin: "https://evil.example" } })).status, 403);
    // A download link can't be used to upload.
    const downloadLink = await createShare("inbox", 24, null);
    assert.equal((await send(tokenOf(downloadLink.url), [{ name: "a.txt", content: "a" }])).status, 404);
    assert.equal((await send(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, [{ name: "a.txt", content: "a" }])).status, 404);
    await revokeShare(link.id);
    assert.equal((await send(token, [{ name: "a.txt", content: "a" }])).status, 404);
    assert.deepEqual(await inbox(root), ["secret.txt"]);

    await assert.rejects(createUploadLink("inbox/secret.txt", 24, 1024 * 1024, null), /for folders/);
    await assert.rejects(createUploadLink("", 24, 1024 * 1024, null), /root folder/);
    await assert.rejects(createUploadLink("inbox", 24, 1, null), /1 MB and 1 TB/);
  });
});

test("upload links keep to their size and file limits, and leave nothing behind when refused", async () => {
  await withRoot(async (root) => {
    const twoFiles = await createUploadLink("inbox", 24, 10 * 1024 * 1024, 2);
    const token = tokenOf(twoFiles.url);
    assert.equal((await send(token, [{ name: "1.txt", content: "1" }])).status, 200);
    assert.equal((await send(token, [{ name: "2.txt", content: "2" }])).status, 200);
    const third = await send(token, [{ name: "3.txt", content: "3" }]);
    assert.equal(third.status, 409);
    assert.equal(third.body.code, "UPLOAD_LINK_FULL");
    await revokeShare(twoFiles.id);

    const small = await createUploadLink("inbox", 24, 1024 * 1024, null);
    const smallToken = tokenOf(small.url);
    const tooBig = await send(smallToken, [{ name: "big.bin", content: Buffer.alloc(1024 * 1024 + 10) }]);
    assert.equal(tooBig.status, 413);
    // Larger than the server's per-file limit.
    const huge = await send(smallToken, [{ name: "huge.bin", content: Buffer.alloc(5 * 1024 * 1024) }]);
    assert.equal(huge.status, 413);
    // Only one file per request; extra files aren't saved.
    assert.equal((await send(smallToken, [{ name: "a.txt", content: "a" }, { name: "b.txt", content: "b" }])).status, 200);
    assert.equal((await send(smallToken, [{ name: "c.txt", content: "c" }], { field: "files" })).status, 400);
    assert.deepEqual(await inbox(root), ["1.txt", "2.txt", "a.txt"]);

    // Uploads at the same time share the room: both can't be promised more than the link has left.
    const settleFirst = await reserveUpload(small.id, 600 * 1024);
    await assert.rejects(reserveUpload(small.id, 600 * 1024), /larger than the room left/);
    await settleFirst();
    const settleAgain = await reserveUpload(small.id, 600 * 1024);
    await settleAgain(600 * 1024);
    await assert.rejects(reserveUpload(small.id, 600 * 1024), /larger than the room left/);
  });
});

test("an upload link stops working if its folder is replaced", async () => {
  await withRoot(async (root) => {
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, null);
    await fs.rename(path.join(root, "inbox"), path.join(root, "old-inbox"));
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "inbox"));
    assert.equal((await send(tokenOf(link.url), [{ name: "a.txt", content: "a" }])).status, 404);
    await fs.unlink(path.join(root, "inbox"));
    await fs.mkdir(path.join(root, "inbox"));
    assert.equal((await send(tokenOf(link.url), [{ name: "a.txt", content: "a" }])).status, 404);
    assert.deepEqual(await fs.readdir(path.join(root, "elsewhere")), []);
    assert.deepEqual(await fs.readdir(path.join(root, "inbox")), []);
  });
});
