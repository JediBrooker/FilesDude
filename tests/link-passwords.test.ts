import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createShare, createUploadLink, listShares } from "../lib/shares";
import { GET as download } from "../app/s/[token]/download/route";
import { POST as unlock } from "../app/s/[token]/unlock/route";
import { POST as upload } from "../app/s/[token]/upload/route";
import { POST as pieces } from "../app/s/[token]/upload/pieces/route";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-link-passwords-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  await fs.writeFile(path.join(root, "report.pdf"), "the report");
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, sharingEnabled: config.sharingEnabled };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "link-password-test-session-secret-with-32-chars", sharingEnabled: true });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.replace(/^\/s\//, "");
const context = (token: string) => ({ params: Promise.resolve({ token }) });
const base = { host: "localhost", origin: "http://localhost", "x-filedude-request": "1" };
const tryPassword = (token: string, password: string, address?: string) =>
  unlock(new Request(`http://localhost/s/${token}/unlock`, { method: "POST", headers: { ...base, "content-type": "application/json", ...(address ? { "x-test-address": address } : {}) }, body: JSON.stringify({ password }) }), context(token));
const fetchFile = (token: string, cookie = "") => download(new Request(`http://localhost/s/${token}/download`, { headers: cookie ? { cookie } : {} }), context(token));
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

test("a link with a password opens only after the password is entered, in that browser", async () => {
  await withRoot(async () => {
    await assert.rejects(createShare("report.pdf", 24, null, "short"), /8 to 256 characters/);
    const link = await createShare("report.pdf", 24, null, "correct horse battery");
    assert.equal(link.protected, true);
    // Kept apart from open links, where versions without passwords would serve it.
    const stored = JSON.parse(await fs.readFile(path.join(config.stateDir, "protected-shares.json"), "utf8"));
    assert.match(stored[0].passwordHash, /^scrypt\$/);
    assert.doesNotMatch(JSON.stringify(stored), /correct horse/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.stateDir, "shares.json"), "utf8")), []);
    // The owner's list never includes the hash.
    assert.equal("passwordHash" in (await listShares())[0], false);

    const token = tokenOf(link.url);
    assert.equal((await fetchFile(token)).status, 401);
    const wrong = await tryPassword(token, "not the password");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const right = await tryPassword(token, "correct horse battery");
    assert.equal(right.status, 200);
    const setCookie = right.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`Path=/s/${token.replace(/\./g, "\\.")}; HttpOnly; SameSite=Lax; Max-Age=43200`));
    const cookie = cookieOf(right);
    const opened = await fetchFile(token, cookie);
    assert.equal(opened.status, 200);
    assert.equal(await opened.text(), "the report");

    // The cookie works for that link only, and can't be forged or stretched.
    const other = await createShare("report.pdf", 24, null, "correct horse battery");
    assert.equal((await fetchFile(tokenOf(other.url), cookie.replace(/^fdl_[^=]+/, `fdl_${other.id}`))).status, 401);
    const [name, value] = cookie.split("=");
    const [, signature] = value.split(".");
    assert.equal((await fetchFile(token, `${name}=${Math.floor(Date.now() / 1000) + 10 ** 7}.${signature}`)).status, 401);
    assert.equal((await fetchFile(token, `${name}=${Math.floor(Date.now() / 1000) - 10}.${signature}`)).status, 401);
    // A link without a password needs no cookie.
    const open = await createShare("report.pdf", 24, null);
    assert.equal(open.protected, false);
    assert.equal((await fetchFile(tokenOf(open.url))).status, 200);
  });
});

test("wrong passwords are limited and recorded", async () => {
  await withRoot(async () => {
    const link = await createShare("report.pdf", 24, null, "correct horse battery");
    const token = tokenOf(link.url);
    for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await tryPassword(token, `guess ${attempt}`)).status, 401);
    // Even the right password is refused once the limit is reached.
    assert.equal((await tryPassword(token, "correct horse battery")).status, 429);
    const audit = await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8");
    assert.equal(audit.split("\n").filter((line) => line.includes("share.unlock_failed")).length, 10);
    // Guesses sent together can't get past the limit either.
    const second = await createShare("report.pdf", 24, null, "another long password");
    const results = await Promise.all(Array.from({ length: 30 }, () => tryPassword(tokenOf(second.url), "nope nope nope")));
    // No more than ten are checked (fewer when the cap on password checks at once turns some away).
    assert.ok(results.filter((response) => response.status === 401).length <= 10);
    assert.equal(results.filter((response) => response.status === 401 || response.status === 429).length, 30);
  });
});

test("one visitor's guesses don't lock others out, and right passwords don't count", async () => {
  await withRoot(async () => {
    const original = config.trustProxy;
    config.trustProxy = true;
    try {
      const link = await createShare("report.pdf", 24, null, "correct horse battery");
      const token = tokenOf(link.url);
      const from = (address: string, password: string) => unlock(new Request(`http://localhost/s/${token}/unlock`, { method: "POST", headers: { ...base, "content-type": "application/json", "x-forwarded-for": address }, body: JSON.stringify({ password }) }), context(token));
      // One address past its own limit doesn't use up the link's.
      for (let attempt = 0; attempt < 50; attempt += 1) await from("203.0.113.1", `guess ${attempt}`);
      assert.equal((await from("203.0.113.2", "correct horse battery")).status, 200);
      // Many people entering the right password are all let in.
      for (let person = 0; person < 60; person += 1) assert.equal((await from(`198.51.100.${person}`, "correct horse battery")).status, 200);
      // Enough wrong guesses from many addresses close the link, and the owner is told once.
      for (let address = 10; address < 20; address += 1) for (let attempt = 0; attempt < 5; attempt += 1) await from(`192.0.2.${address}`, "wrong wrong");
      assert.equal((await from("192.0.2.99", "correct horse battery")).status, 429);
      assert.equal((await from("192.0.2.98", "correct horse battery")).status, 429);
      const audit = await fs.readFile(path.join(config.stateDir, "audit.jsonl"), "utf8");
      assert.equal(audit.split("\n").filter((line) => line.includes("share.unlock_locked")).length, 1);
    } finally {
      config.trustProxy = original;
    }
  });
});

test("an upload link with a password takes files only once it's entered", async () => {
  await withRoot(async (root) => {
    const link = await createUploadLink("inbox", 24, 10 * 1024 * 1024, null, "upload password here");
    const token = tokenOf(link.url);
    const send = async (cookie = "") => {
      const form = new FormData();
      form.append("file", new Blob(["hello"]), "hello.txt");
      const encoded = new Response(form);
      const body = Buffer.from(await encoded.arrayBuffer());
      return upload(new Request(`http://localhost/s/${token}/upload`, { method: "POST", headers: { ...base, cookie, "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length) }, body }), context(token));
    };
    const start = (cookie = "") => pieces(new Request(`http://localhost/s/${token}/upload/pieces`, { method: "POST", headers: { ...base, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "start", name: "big.bin", size: 10 }) }), context(token));
    assert.equal((await send()).status, 401);
    assert.equal((await start()).status, 401);
    assert.deepEqual(await fs.readdir(path.join(root, "inbox")), []);
    const cookie = cookieOf(await tryPassword(token, "upload password here"));
    assert.equal((await send(cookie)).status, 200);
    assert.deepEqual(await fs.readdir(path.join(root, "inbox")), ["hello.txt"]);
  });
});
