import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createConnection, trustHostKey } from "../lib/connections";
import { cancelJob, waitForJob } from "../lib/jobs";
import { setStallTimeout, startCopyFromServer } from "../lib/remote-transfer";
import { closeSession, listRemote, setSftpTimeouts, testConnection } from "../lib/sftp";
import { dirAttrs, fileAttrs, startHostileServer, type Scenario } from "./helpers/hostile-sftp-server";

// Each test runs FilesDude against a server that misbehaves on purpose.
async function withHostile<T>(scenario: Scenario, run: (context: { id: string; root: string }) => Promise<T>, options: { root?: string } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-hostile-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "in"), { recursive: true });
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret };
  Object.assign(config, { root, stateDir: path.join(base, "state"), sessionSecret: "hostile-test-session-secret-with-more-than-32-characters" });
  const server = await startHostileServer(scenario);
  const connection = await createConnection({ name: "Hostile", host: "127.0.0.1", port: server.port, username: "x", auth: "password", password: "x", root: options.root ?? "/" });
  try {
    const unknown = await testConnection(connection.id).catch((error) => error);
    await trustHostKey(connection.id, unknown.fingerprint);
    return await run({ id: connection.id, root });
  } finally {
    await closeSession(connection.id);
    await server.close();
    setStallTimeout(undefined);
    setSftpTimeouts({});
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const leftovers = async (root: string) => (await fs.readdir(path.join(root, "in"))).filter((name) => name.startsWith(".filesdude"));
const endless = (prefix: string) => (_path: string, call: number) => Array.from({ length: 500 }, (_, index) => ({ filename: `${prefix}${call}-${index}`, attrs: fileAttrs(0) }));

test("a listing that never ends is cut off, not read forever", async () => {
  const started = Date.now();
  await withHostile({ stat: () => dirAttrs(), readdir: endless("f"), read: () => null }, async ({ id }) => {
    const listing = await listRemote(id, "");
    assert.equal(listing.truncated, true);
    assert.equal(listing.entries.length, 10_000);
  });
  assert.ok(Date.now() - started < 15_000);
});

test("copying a folder whose listing never ends fails and leaves nothing behind", async () => {
  await withHostile({ stat: (requested) => (requested === "/" || requested === "/big" ? dirAttrs() : fileAttrs(0)), readdir: endless("f"), read: () => null }, async ({ id, root }) => {
    const { failure } = await waitForJob((await startCopyFromServer(id, ["big"], "in", () => undefined)).id);
    assert.match(failure!.message, /too much/);
    assert.deepEqual(await leftovers(root), []);
  });
});

test("a file that sends more than it claims is stopped, and nothing is left", async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  await withHostile({ stat: (requested) => (requested === "/" ? dirAttrs() : fileAttrs(1)), readdir: () => null, read: () => chunk }, async ({ id, root }) => {
    const { failure, state } = await waitForJob((await startCopyFromServer(id, ["grow.bin"], "in", () => undefined)).id);
    assert.match(failure!.message, /more than it said/);
    assert.ok(state.progress.done < 1024 * 1024);
    assert.deepEqual(await fs.readdir(path.join(root, "in")), []);
  });
});

test("a folder that lists differently when copied than when measured is held to what was measured", async () => {
  await withHostile({
    stat: (requested) => (requested === "/" || requested === "/d" ? dirAttrs() : fileAttrs(0)),
    // Empty when measured; then files that turn out to have data.
    readdir: (requested, call, opened) => (requested !== "/d" || opened === 1 || call > 0 ? null : Array.from({ length: 50 }, (_, index) => ({ filename: `f${index}`, attrs: fileAttrs(0) }))),
    read: (_requested, offset) => (offset === 0 ? Buffer.from("surprise") : null),
  }, async ({ id, root }) => {
    const { failure } = await waitForJob((await startCopyFromServer(id, ["d"], "in", () => undefined)).id);
    assert.match(failure!.message, /more than it said/);
    assert.deepEqual(await leftovers(root), []);
  });
});

test("a copy from a server that stops answering can be cancelled, and leaves nothing", async () => {
  await withHostile({ stat: (requested) => (requested === "/" || requested === "/d" ? dirAttrs() : fileAttrs(10)), readdir: (requested, call) => (requested === "/d" && call === 0 ? [{ filename: "f", attrs: fileAttrs(10) }] : null), read: () => "hang" }, async ({ id, root }) => {
    const job = await startCopyFromServer(id, ["d"], "in", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // While it runs, the placeholder can only be opened by FilesDude.
    const [placeholder] = await leftovers(root);
    assert.equal((await fs.stat(path.join(root, "in", placeholder))).mode & 0o777, 0o700);
    const started = Date.now();
    cancelJob(job.id);
    const { state } = await waitForJob(job.id);
    assert.equal(state.status, "cancelled");
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await leftovers(root), []);
  });
});

test("a copy from a server that stops answering is stopped by itself", async () => {
  await withHostile({ stat: (requested) => (requested === "/" ? dirAttrs() : fileAttrs(10)), readdir: () => null, read: () => "hang" }, async ({ id, root }) => {
    setStallTimeout(600);
    const { failure } = await waitForJob((await startCopyFromServer(id, ["f.bin"], "in", () => undefined)).id);
    assert.match(failure!.message, /stopped responding/);
    assert.deepEqual(await fs.readdir(path.join(root, "in")), []);
  });
});

test("a server that never finishes connecting fails in time, and closing it doesn't hang", async () => {
  setSftpTimeouts({ open: 800, call: 800 });
  const started = Date.now();
  await withHostile({ realpath: (requested) => (requested === "." ? "hang" : requested), stat: () => dirAttrs(), readdir: () => null, read: () => null }, async ({ id }) => {
    await assert.rejects(listRemote(id, ""), /stopped responding/);
    await closeSession(id);
  }, { root: "" }).catch((error) => {
    // Setting up needs the same realpath, so it may be what fails.
    assert.match((error as Error).message, /stopped responding|fingerprint/);
  });
  assert.ok(Date.now() - started < 10_000);
});
