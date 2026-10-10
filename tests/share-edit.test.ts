import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createShare, createUploadLink, recordShareDownload, reserveUpload, resolveShareToken, updateShare } from "../lib/shares";
import { GET as download } from "../app/s/[token]/download/route";
import { POST as unlock } from "../app/s/[token]/unlock/route";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-share-edit-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  await fs.writeFile(path.join(root, "report.pdf"), "the report");
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "share-edit-test-session-secret-with-32-chars", sharingEnabled: true });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.replace(/^\/s\//, "");
const context = (token: string) => ({ params: Promise.resolve({ token }) });
const fetchFile = (token: string, cookie = "") => download(new Request(`http://localhost/s/${token}/download`, { headers: cookie ? { cookie } : {} }), context(token));
const enter = async (token: string, password: string) => {
  const response = await unlock(new Request(`http://localhost/s/${token}/unlock`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", "x-filedude-request": "1", "content-type": "application/json" }, body: JSON.stringify({ password }) }), context(token));
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
};

test("a link's expiry and download limit can be changed, but not below what's been used", async () => {
  await withRoot(async () => {
    const link = await createShare("report.pdf", 1, 5);
    await recordShareDownload(link.id);
    await recordShareDownload(link.id);
    const { link: longer, changed } = await updateShare(link.id, { hours: 720 });
    assert.deepEqual(changed, ["expiry"]);
    assert.ok(Date.parse(longer.expiresAt) > Date.now() + 29 * 24 * 3_600_000);
    await assert.rejects(updateShare(link.id, { maxDownloads: 2 }), /already been downloaded 2 times/);
    assert.equal((await updateShare(link.id, { maxDownloads: null })).link.maxDownloads, null);
    assert.equal((await updateShare(link.id, { maxDownloads: 3 })).link.maxDownloads, 3);
    await assert.rejects(updateShare(link.id, {}), /Nothing to change/);
    await assert.rejects(updateShare(link.id, { hours: 0 }), /1 hour to 30 days/);
    await assert.rejects(updateShare(link.id, { maxBytes: 1024 ** 3 }), /Only upload links/);
    await assert.rejects(updateShare("AAAAAAAAAAAAAAAA", { hours: 1 }), /no longer exists/);
  });
});

test("an upload link's limits can be changed, not below what it has received", async () => {
  await withRoot(async () => {
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, 10);
    await assert.rejects(updateShare(link.id, { maxDownloads: 5 }), /don't have a download limit/);
    const { link: changed } = await updateShare(link.id, { maxBytes: 1024 ** 3, maxFiles: null });
    assert.equal(changed.maxBytes, 1024 ** 3);
    assert.equal(changed.maxFiles, null);
    assert.equal(changed.kind, "upload");
    // Room promised to uploads under way counts as received.
    const settle = await reserveUpload(link.id, 80 * 1024 * 1024);
    await assert.rejects(updateShare(link.id, { maxBytes: 10 * 1024 * 1024 }), /receiving/);
    await settle();
    assert.equal((await updateShare(link.id, { maxBytes: 10 * 1024 * 1024 })).link.maxBytes, 10 * 1024 * 1024);
  });
});

test("adding, changing, or removing a password ends earlier unlocks", async () => {
  await withRoot(async () => {
    const link = await createShare("report.pdf", 24, null);
    const token = tokenOf(link.url);
    assert.equal((await fetchFile(token)).status, 200);

    const { link: locked, changed } = await updateShare(link.id, { password: "first long password" });
    assert.deepEqual(changed, ["password added"]);
    assert.equal(locked.protected, true);
    assert.equal("passwordHash" in locked, false);
    // It moved to the protected file, so older versions wouldn't serve it.
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.stateDir, "shares.json"), "utf8")), []);
    assert.equal((await fetchFile(token)).status, 401);
    const first = await enter(token, "first long password");
    assert.equal((await fetchFile(token, first)).status, 200);

    await assert.rejects(updateShare(link.id, { password: "short" }), /8 to 256 characters/);
    assert.deepEqual((await updateShare(link.id, { password: "second long password" })).changed, ["password changed"]);
    assert.equal((await fetchFile(token, first)).status, 401);
    const second = await enter(token, "second long password");
    assert.equal((await fetchFile(token, second)).status, 200);

    assert.deepEqual((await updateShare(link.id, { password: null })).changed, ["password removed"]);
    assert.equal((await fetchFile(token)).status, 200);
    assert.equal((await resolveShareToken(token))?.passwordHash, undefined);
    assert.equal(JSON.parse(await fs.readFile(path.join(config.stateDir, "shares.json"), "utf8")).length, 1);
  });
});
