import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createShare, listShares, recordShareDownload, resolveShareToken, revokeShare, rewriteSharePaths } from "../lib/shares";
import { GET as download } from "../app/s/[token]/download/route";

async function withShareRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-shares-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "share-test-session-secret-with-more-than-32-characters", sharingEnabled: true });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.replace(/^\/s\//, "");
const fetchShare = (token: string, headers: Record<string, string> = {}) =>
  download(new Request(`http://localhost/s/${token}/download`, { headers }), { params: Promise.resolve({ token }) });

test("links resolve only with their exact signed token", async () => {
  await withShareRoot(async (root) => {
    await fs.writeFile(path.join(root, "report.pdf"), "pdf");
    const share = await createShare("report.pdf", 24, null);
    assert.match(share.url, /^\/s\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(share.url);
    assert.equal((await resolveShareToken(token))?.path, "report.pdf");
    const [id, signature] = token.split(".");
    for (const bad of [`${id}.${signature.slice(0, -1)}A`, `${id}.`, id, `${id}.${signature}.x`, `AAAAAAAAAAAAAAAA.${signature}`, "", "../../etc"]) {
      assert.equal(await resolveShareToken(bad), null, bad);
    }
    config.sessionSecret = "a-different-rotated-session-secret-of-enough-length";
    assert.equal(await resolveShareToken(token), null);
  });
});

test("links expire, run out, and can be revoked", async () => {
  await withShareRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const once = await createShare("a.txt", 1, 1);
    assert.equal(await recordShareDownload(once.id), true);
    assert.equal(await recordShareDownload(once.id), false);
    assert.equal(await resolveShareToken(tokenOf(once.url)), null);

    const revoked = await createShare("a.txt", 1, null);
    await revokeShare(revoked.id);
    assert.equal(await resolveShareToken(tokenOf(revoked.url)), null);

    const expiring = await createShare("a.txt", 1, null);
    const file = path.join(config.stateDir, "shares.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    stored.find((item: { id: string }) => item.id === expiring.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(file, JSON.stringify(stored));
    assert.equal(await resolveShareToken(tokenOf(expiring.url)), null);
    assert.deepEqual(await listShares(), []);

    await assert.rejects(createShare("a.txt", 0, null), /1 hour to 30 days/);
    await assert.rejects(createShare("a.txt", 24 * 31, null), /1 hour to 30 days/);
    await assert.rejects(createShare("", 24, null), /root folder/);
    await assert.rejects(createShare(".filedude/trash", 24, null), /reserved/);
  });
});

test("links follow renames and moves and are revoked when the item is deleted", async () => {
  await withShareRoot(async (root) => {
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "plan.txt"), "plan");
    const share = await createShare("docs/plan.txt", 24, null);
    await rewriteSharePaths([{ from: "docs", to: "archive/docs" }]);
    assert.equal((await resolveShareToken(tokenOf(share.url)))?.path, "archive/docs/plan.txt");
    await rewriteSharePaths([{ from: "archive" }]);
    assert.equal(await resolveShareToken(tokenOf(share.url)), null);
  });
});

test("sharing can be turned off entirely", async () => {
  await withShareRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const share = await createShare("a.txt", 24, null);
    config.sharingEnabled = false;
    assert.equal(await resolveShareToken(tokenOf(share.url)), null);
    await assert.rejects(createShare("a.txt", 24, null), /turned off/);
    assert.equal((await fetchShare(tokenOf(share.url))).status, 404);
  });
});

test("public downloads are attachments that never render and count only full downloads", async () => {
  await withShareRoot(async (root) => {
    await fs.writeFile(path.join(root, "page.html"), "<script>alert(1)</script>");
    const share = await createShare("page.html", 24, 2);
    const token = tokenOf(share.url);

    const full = await fetchShare(token);
    assert.equal(full.status, 200);
    assert.match(full.headers.get("content-disposition") || "", /^attachment; filename="page\.html"/);
    assert.match(full.headers.get("content-security-policy") || "", /sandbox/);
    assert.equal(full.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await full.text(), "<script>alert(1)</script>");

    const resumed = await fetchShare(token, { range: "bytes=8-" });
    assert.equal(resumed.status, 206);
    assert.equal(await resumed.text(), "alert(1)</script>");
    assert.equal((await listShares())[0].downloads, 1);

    assert.equal((await fetchShare(token)).status, 200);
    const exhausted = await fetchShare(token);
    assert.equal(exhausted.status, 404);
    assert.match(await exhausted.text(), /invalid, has expired, or the item is no longer available/);
  });
});

test("folders download as a zip without FilesDude's internal folders", async () => {
  await withShareRoot(async (root) => {
    await fs.mkdir(path.join(root, "site", ".filedude"), { recursive: true });
    await fs.writeFile(path.join(root, "site", "index.html"), "hi");
    await fs.writeFile(path.join(root, "site", ".filedude", "secret.json"), "secret-marker");
    const share = await createShare("site", 24, null);
    const response = await fetchShare(tokenOf(share.url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.includes(Buffer.from("site/index.html")));
    assert.ok(!body.includes(Buffer.from("secret")));
  });
});

test("a tampered share record cannot reach outside the root", async () => {
  await withShareRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(path.dirname(root), "outside.txt"), "secret");
    const share = await createShare("a.txt", 24, null);
    const file = path.join(config.stateDir, "shares.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    stored[0].path = "../outside.txt";
    stored[0].name = "outside.txt";
    await fs.writeFile(file, JSON.stringify(stored));
    const response = await fetchShare(tokenOf(share.url));
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});
