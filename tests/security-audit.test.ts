import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { audit, AUDIT_FILE, MAX_AUDIT_BYTES } from "../lib/audit";
import { assertLoginAllowed, checkLoginRateLimit, checkUsernameRateLimit, createSession } from "../lib/auth";
import { config, configurationIssues } from "../lib/config";
import { addFavorite, forgetAccountFavorites, listFavorites } from "../lib/favorites";
import { previewBulkRename, validateName } from "../lib/files";
import { runInScope } from "../lib/scope";
import { publicName, uploadName } from "../lib/upload-target";
import { createUser } from "../lib/users";
import { POST as preferences } from "../app/api/auth/preferences/route";

// Regression tests for the fixes from the full security review.

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (context: { root: string; state: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-audit-fixes-")));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  await fs.mkdir(path.join(root, "home", "bob"), { recursive: true });
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, username: config.username };
  Object.assign(config, { root, stateDir: state, username: "owner", passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("owner-password-long", salt)).toString("base64url")}`, sessionSecret: "audit-fixes-test-session-secret-with-more-than-32-chars" });
  try {
    return await run({ root, state });
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("a bulk rename pattern that takes too long is stopped, without holding up the server", async () => {
  await withRoot(async ({ root }) => {
    await fs.writeFile(path.join(root, `${"a".repeat(40)}!.txt`), "x");
    await fs.writeFile(path.join(root, "photo 1.jpg"), "x");
    const started = Date.now();
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    await assert.rejects(previewBulkRename([`${"a".repeat(40)}!.txt`], { find: "^(a+)+$", regex: true }), /takes too long/);
    clearInterval(ticker);
    assert.ok(Date.now() - started < 5_000);
    // The main thread kept going meanwhile.
    assert.ok(ticks >= 5, `${ticks} ticks`);
    await assert.rejects(previewBulkRename(["photo 1.jpg"], { find: "(", regex: true }), /invalid/);
    assert.equal((await previewBulkRename(["photo 1.jpg"], { find: "\\s(\\d)", replace: "-$1", regex: true }))[0].to, "photo-1.jpg");
  });
});

test("bulk rename rules and names can't be made huge", async () => {
  await withRoot(async ({ root }) => {
    await fs.writeFile(path.join(root, "a.txt"), "x");
    await assert.rejects(previewBulkRename(["a.txt"], { numbering: true, pad: 200_000_000 }), /at most 10 digits/);
    await assert.rejects(previewBulkRename(["a.txt"], { prefix: "p".repeat(300) }), /too long/);
    await assert.rejects(previewBulkRename(["a.txt"], { numbering: true, start: -5 }), /start between/);
    await assert.rejects(previewBulkRename(["a.txt"], { regex: "yes" as unknown as boolean }), /invalid/);
    assert.throws(() => validateName("n".repeat(256)), /too long/);
    assert.equal(validateName("é".repeat(127)), "é".repeat(127));
    assert.throws(() => validateName("é".repeat(128)), /too long/);
  });
});

test("names can't hide what they are, and an uploaded name can't start with a dash", () => {
  assert.equal(uploadName("invoice\u202efdp.exe"), "invoice_fdp.exe");
  assert.equal(validateName("bell\u0007 and\u2066 isolate"), "bell_ and_ isolate");
  assert.equal(publicName("--checkpoint-action=exec=sh x.sh"), "_-checkpoint-action=exec=sh x.sh");
  assert.equal(publicName(".htaccess"), "_htaccess");
  assert.equal(publicName("ordinary - name.txt"), "ordinary - name.txt");
});

test("sign-in tries are counted per IPv6 /64, and per username", () => {
  const block = `2001:db8:${crypto.randomBytes(2).toString("hex")}:1`;
  for (let index = 1; index <= 5; index += 1) checkLoginRateLimit(`${block}::${index}`);
  assert.throws(() => checkLoginRateLimit(`${block}::9999`), /Too many login attempts/);
  assert.throws(() => assertLoginAllowed(`${block}:abcd::1`), /Too many login attempts/);
  // Another /64 isn't affected.
  checkLoginRateLimit(`2001:db8:${crypto.randomBytes(2).toString("hex")}:2::1`);
  const name = `Someone${crypto.randomBytes(4).toString("hex")}`;
  for (let index = 0; index < 20; index += 1) checkUsernameRateLimit(index % 2 ? name : name.toLowerCase());
  assert.throws(() => checkUsernameRateLimit(name.toUpperCase()), /Too many login attempts/);
});

test("asking for passkey challenges takes no room, and a full table never turns everyone away", () => {
  for (let index = 0; index < 12_000; index += 1) assertLoginAllowed(`2001:db8:${(index >> 8).toString(16)}:${(index & 255).toString(16)}::1`);
  for (let index = 0; index < 10_500; index += 1) checkLoginRateLimit(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`);
  // A newcomer still gets in (the oldest entries made room).
  checkLoginRateLimit("192.0.2.77");
});

test("changing a password checks the current one within a limit", async () => {
  await withRoot(async () => {
    const bob = await createUser({ username: "bob", password: "bob-password-long", role: "editor", root: "home/bob" });
    const cookie = `fd_session=${createSession("bob", 1, bob.id)}`;
    const change = (currentPassword: string) => preferences(new Request("http://localhost/api/auth/preferences", { method: "POST", headers: { cookie, "content-type": "application/json", "x-filedude-request": "1" }, body: JSON.stringify({ currentPassword, newPassword: "a-brand-new-password" }) }));
    for (let index = 0; index < 10; index += 1) assert.equal((await change(`wrong-${index}`)).status, 401);
    assert.equal((await change("bob-password-long")).status, 429);
  });
});

test("repeatable events are recorded once a minute, and recent history is never removed", async () => {
  await withRoot(async ({ state }) => {
    for (let index = 0; index < 30; index += 1) await audit("fs.download", { username: "bob", path: "home/bob/a.txt" });
    await audit("fs.download", { username: "bob", path: "home/bob/b.txt" });
    await audit("fs.rename", { username: "bob", path: "home/bob/a.txt" });
    await audit("fs.rename", { username: "bob", path: "home/bob/a.txt" });
    const lines = (await fs.readFile(path.join(state, AUDIT_FILE), "utf8")).trim().split("\n").map((item) => JSON.parse(item) as { event: string; path: string });
    assert.deepEqual(lines.map((item) => `${item.event} ${item.path}`), ["fs.download home/bob/a.txt", "fs.download home/bob/b.txt", "fs.rename home/bob/a.txt", "fs.rename home/bob/a.txt"]);
    // A day-old archive survives even with over a gigabyte of newer history (sparse files).
    const victim = path.join(state, "audit-20260101T000000000Z.jsonl");
    await fs.writeFile(victim, `${JSON.stringify({ event: "fs.delete", username: "mallory" })}\n`);
    await fs.utimes(victim, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    const flood = path.join(state, "audit-20260102T000000000Z.jsonl");
    await fs.writeFile(flood, "");
    await fs.truncate(flood, 1100 * 1024 * 1024);
    await fs.truncate(path.join(state, AUDIT_FILE), MAX_AUDIT_BYTES);
    await audit("fs.rename", { username: "bob", path: "rotate" });
    assert.ok(await fs.stat(victim));
    // Over the limit, repeatable events are set aside, and everything else still recorded.
    await audit("fs.download", { username: "bob", path: "home/bob/c.txt" });
    await audit("users.delete", { username: "owner", account: "bob" });
    const latest = (await fs.readFile(path.join(state, AUDIT_FILE), "utf8")).trim().split("\n").map((item) => (JSON.parse(item) as { event: string }).event);
    assert.ok(!latest.includes("fs.download"));
    assert.ok(latest.includes("users.delete"));
  });
});

test("settings that don't read right are reported, not treated as no limit", () => {
  const original = { sessionHours: config.sessionHours, maxUploadBytes: config.maxUploadBytes };
  try {
    Object.assign(config, { maxUploadBytes: Number.NaN });
    assert.ok(configurationIssues().some((issue) => issue.includes("FILEDUDE_MAX_UPLOAD_MB")));
    Object.assign(config, { maxUploadBytes: original.maxUploadBytes, sessionHours: Number.NaN });
    assert.ok(configurationIssues().some((issue) => issue.includes("FILEDUDE_SESSION_HOURS")));
  } finally {
    Object.assign(config, original);
  }
});

test("favourites are capped, and a removed account's go", async () => {
  await withRoot(async ({ root }) => {
    for (let index = 0; index <= 200; index += 1) await fs.mkdir(path.join(root, "home", "bob", `f${index}`));
    await runInScope({ accountKey: "bob-id", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      for (let index = 0; index < 200; index += 1) await addFavorite(`home/bob/f${index}`);
      await assert.rejects(addFavorite("home/bob/f200"), /Up to 200/);
      await forgetAccountFavorites("bob-id");
      assert.deepEqual(await listFavorites(), []);
    });
  });
});
