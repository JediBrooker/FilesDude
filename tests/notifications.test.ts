import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { audit } from "../lib/audit";
import { checkFreeSpace, flushNotificationsForTests, getNotificationSettings, notify, saveNotificationSettings, sendTestNotification } from "../lib/notifications";

type Received = { headers: http.IncomingHttpHeaders; body: string };

async function withReceiver<T>(run: (context: { url: string; received: Received[]; status: { code: number } }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-notify-")));
  await fs.mkdir(path.join(base, "root"));
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root: path.join(base, "root"), stateDir: path.join(base, "state") });
  const received: Received[] = [];
  const status = { code: 200 };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = status.code;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  flushNotificationsForTests();
  try {
    return await run({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received, status });
  } finally {
    flushNotificationsForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("settings are checked and saved, and the ntfy token is never shown", async () => {
  await withReceiver(async ({ url }) => {
    assert.equal((await getNotificationSettings()).kind, null);
    await assert.rejects(saveNotificationSettings({ kind: "pager", url }), /Choose where/);
    await assert.rejects(saveNotificationSettings({ kind: "ntfy", url: "ftp://example.com" }), /http/);
    await assert.rejects(saveNotificationSettings({ kind: "ntfy", url: "not a url" }), /valid address/);
    // A bare ntfy topic, as ntfy's apps take it, means that topic on ntfy.sh.
    assert.equal((await saveNotificationSettings({ kind: "ntfy", url: "jedibrooker-9882bc971d27ca66ef16" })).url, "https://ntfy.sh/jedibrooker-9882bc971d27ca66ef16");
    assert.equal((await saveNotificationSettings({ kind: "ntfy", url: "ntfy.example.com/alerts" })).url, "https://ntfy.example.com/alerts");
    // A bare name isn't a Discord or Slack address.
    await assert.rejects(saveNotificationSettings({ kind: "discord", url: "just-a-name" }), /valid address/);
    const saved = await saveNotificationSettings({ kind: "ntfy", url, token: "tk_secret", topics: { signIns: true } });
    assert.equal(saved.hasToken, true);
    assert.equal("token" in saved, false);
    assert.deepEqual(saved.topics, { uploads: true, security: true, signIns: true, storage: true });
    // Leaving the token out keeps it; an empty one removes it.
    assert.equal((await saveNotificationSettings({ kind: "ntfy", url })).hasToken, true);
    assert.equal((await saveNotificationSettings({ kind: "ntfy", url, token: "" })).hasToken, false);
    // A token isn't carried over to a different server.
    await saveNotificationSettings({ kind: "ntfy", url, token: "tk_private" });
    assert.equal((await saveNotificationSettings({ kind: "ntfy", url: "https://ntfy.sh/other-topic" })).hasToken, false);
    // Credentials in the address are refused (they'd only end up in logs).
    await assert.rejects(saveNotificationSettings({ kind: "ntfy", url: "https://user:secret@ntfy.example.com/topic" }), /user name and password/);
    assert.equal((await fs.stat(path.join(config.stateDir, "notifications.json"))).mode & 0o777, 0o600);
    assert.equal((await saveNotificationSettings({ kind: "off" })).kind, null);
  });
});

test("each service gets its own format, with names shown as text", async () => {
  await withReceiver(async ({ url, received }) => {
    await saveNotificationSettings({ kind: "ntfy", url, token: "tk_secret" });
    await notify({ topic: "security", urgent: true, title: "Café alert", message: "Someone tried" });
    assert.equal(received[0].body, "Someone tried");
    assert.equal(received[0].headers.title, "Caf? alert");
    assert.equal(received[0].headers.priority, "high");
    assert.equal(received[0].headers.authorization, "Bearer tk_secret");

    await saveNotificationSettings({ kind: "discord", url });
    await notify({ topic: "uploads", title: "1 file received", message: "@everyone **bold** <@123>" });
    const discord = JSON.parse(received[1].body);
    assert.deepEqual(discord.allowed_mentions, { parse: [] });
    assert.equal(discord.flags, 4);
    assert.match(discord.content, /\\@everyone \\\*\\\*bold\\\*\\\*/);

    await saveNotificationSettings({ kind: "slack", url });
    await notify({ topic: "uploads", title: "x", message: "<!channel> & <script> https://evil.example/login" });
    const slack = JSON.parse(received[2].body);
    assert.equal(slack.text, "*x*\n&lt;!channel&gt; &amp; &lt;script&gt; https:\u200b//evil.\u200bexample/login");
    assert.equal(slack.unfurl_links, false);

    await saveNotificationSettings({ kind: "webhook", url });
    await notify({ topic: "storage", title: "t", message: "m" });
    const hook = JSON.parse(received[3].body);
    assert.equal(hook.source, "filesdude");
    assert.equal(hook.topic, "storage");

    // A topic that's off sends nothing.
    await saveNotificationSettings({ kind: "webhook", url, topics: { storage: false } });
    await notify({ topic: "storage", title: "t", message: "m" });
    assert.equal(received.length, 4);
  });
});

test("what the audit log records becomes notifications, gathered and limited", async () => {
  await withReceiver(async ({ url, received }) => {
    await saveNotificationSettings({ kind: "webhook", url, topics: { signIns: true } });
    // Files through one link are told together.
    await audit("share.upload", { id: "link1", path: "Inbox", name: "a.jpg", bytes: 1024, from: "Sam" });
    await audit("share.upload", { id: "link1", path: "Inbox", name: "b.jpg", bytes: 2048, from: "Sam" });
    assert.equal(received.length, 0);
    flushNotificationsForTests();
    await until(() => received.length === 1);
    const uploads = JSON.parse(received[0].body);
    assert.equal(uploads.title, "2 files received");
    assert.match(uploads.message, /a\.jpg, b\.jpg \(3\.0 KB\) arrived in \/Inbox through an upload link from Sam/);

    // Failed sign-ins are told once an address has failed five times.
    for (let attempt = 0; attempt < 7; attempt += 1) await audit("login.failed", { username: "admin", client: "203.0.113.9" });
    await until(() => received.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 2);
    assert.match(JSON.parse(received[1].body).message, /203\.0\.113\.9 has failed to sign in 5 times/);

    await audit("login.succeeded", { username: "cbrooker", client: "198.51.100.1", method: "passkey" });
    await until(() => received.length === 3);
    assert.equal(JSON.parse(received[2].body).message, "cbrooker signed in with a passkey from 198.51.100.1.");
    // Events nobody needs to hear about send nothing.
    await audit("fs.download", { username: "cbrooker", path: "x" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 3);

    // At most 30 an hour for account events (the sign-in above was one); the two messages
    // strangers set off came from their own allowance.
    for (let index = 0; index < 40; index += 1) await notify({ topic: "security", title: `n${index}`, message: "m" });
    assert.equal(received.length, 32);
  });
});

test("strangers can't use up the room for alerts about account changes", async () => {
  await withReceiver(async ({ url, received }) => {
    await saveNotificationSettings({ kind: "webhook", url });
    // Failed sign-ins from many addresses: the first is told at once, the rest held for a summary.
    for (let address = 1; address <= 30; address += 1) for (let attempt = 0; attempt < 5; attempt += 1) await audit("login.failed", { username: "admin", client: `203.0.113.${address}` });
    await until(() => received.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    // Upload links can't flood it either: their own allowance runs out first.
    for (let index = 0; index < 20; index += 1) await notify({ topic: "uploads", budget: "public", title: "u", message: "m" });
    assert.equal(received.length, 10);
    // An account change is still told.
    await audit("settings.two_factor.disabled", { username: "cbrooker" });
    await until(() => received.length === 11);
    assert.equal(JSON.parse(received[10].body).title, "Two-factor sign-in turned off");
  });
});

test("an IPv6 /64 counts as one address for failed sign-ins", async () => {
  await withReceiver(async ({ url, received }) => {
    await saveNotificationSettings({ kind: "webhook", url });
    for (let host = 1; host <= 5; host += 1) await audit("login.failed", { username: "admin", client: `2001:db8:1:2::${host}` });
    await until(() => received.length === 1);
    assert.match(JSON.parse(received[0].body).message, /2001:db8:1:2::\/64 has failed to sign in 5 times/);
  });
});

test("a failed test says why without repeating the address, and low space is told once", async () => {
  await withReceiver(async ({ url, received, status }) => {
    await assert.rejects(sendTestNotification(), /Turn notifications on first/);
    await saveNotificationSettings({ kind: "discord", url });
    status.code = 404;
    await assert.rejects(sendTestNotification(), (error: Error) => /answered 404/.test(error.message) && !error.message.includes(url));
    status.code = 200;
    await sendTestNotification();
    assert.match(JSON.parse(received.at(-1)!.body).content, /FilesDude test/);

    // Free space is only told when it's low; this test disk isn't, so nothing is sent.
    const before = received.length;
    await checkFreeSpace();
    assert.equal(received.length, before);
  });
});
