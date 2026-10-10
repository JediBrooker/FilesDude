import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createConnection, getConnection, listConnections, trustHostKey, updateConnection } from "../lib/connections";
import { waitForJob } from "../lib/jobs";
import { startCopyFromServer, startCopyToServer } from "../lib/remote-transfer";
import { closeSession, deleteRemote, listRemote, makeRemoteFolder, readRemote, renameRemote, testConnection } from "../lib/sftp";
import { startSftpServer } from "./helpers/sftp-server";

const PASSWORD = "remote-test-password";

async function withServer<T>(run: (context: { root: string; remote: string; state: string; port: number; connect: (extra?: Record<string, unknown>) => Promise<string> }) => Promise<T>, options: { publicKeys?: string[] } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-remote-")));
  const root = path.join(base, "root");
  const remote = path.join(base, "remote");
  const state = path.join(base, "state");
  await fs.mkdir(root);
  await fs.mkdir(remote);
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret };
  Object.assign(config, { root, stateDir: state, sessionSecret: "remote-test-session-secret-with-more-than-32-characters" });
  const server = await startSftpServer(remote, { username: "alice", password: PASSWORD, publicKeys: options.publicKeys });
  const ids: string[] = [];
  // Sets up a connection to the test server and confirms its host key.
  const connect = async (extra: Record<string, unknown> = {}) => {
    const connection = await createConnection({ name: "Backup box", host: "127.0.0.1", port: server.port, username: "alice", auth: "password", password: PASSWORD, ...extra });
    ids.push(connection.id);
    const unknown = await testConnection(connection.id).catch((error) => error);
    assert.equal(unknown.code, "HOST_KEY_UNKNOWN");
    await trustHostKey(connection.id, unknown.fingerprint);
    return connection.id;
  };
  try {
    return await run({ root, remote, state, port: server.port, connect });
  } finally {
    for (const id of ids) await closeSession(id);
    await server.close();
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function write(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

test("servers are stored with their credentials encrypted and never shown", async () => {
  await withServer(async ({ state, port }) => {
    const connection = await createConnection({ name: "NAS", host: "nas.local", port, username: "alice", auth: "password", password: "s3cret-pass", root: "/data/" });
    assert.equal(connection.root, "/data");
    assert.equal((connection as Record<string, unknown>).secret, undefined);
    assert.equal(connection.hasSecret, true);
    const stored = await fs.readFile(path.join(state, "connections.json"), "utf8");
    assert.ok(!stored.includes("s3cret-pass"));
    assert.equal(((await fs.stat(path.join(state, "connections.json"))).mode & 0o777), 0o600);
    assert.deepEqual((await listConnections()).map((item) => item.name), ["NAS"]);
    // Editing without a new password keeps the old one; a new host must be confirmed again.
    await trustHostKey(connection.id, `SHA256:${"A".repeat(43)}`);
    const renamed = await updateConnection(connection.id, { name: "NAS 2", host: "nas.local", port, username: "alice", auth: "password" });
    assert.equal(renamed.hostKey, `SHA256:${"A".repeat(43)}`);
    const moved = await updateConnection(connection.id, { name: "NAS 2", host: "other.local", port, username: "alice", auth: "password" });
    assert.equal(moved.hostKey, undefined);
    // A generated key keeps only its public half visible.
    const keyed = await createConnection({ name: "Keyed", host: "nas.local", username: "alice", auth: "key" });
    assert.match(keyed.publicKey!, /^ssh-ed25519 /);
    for (const bad of [{ host: "nas local" }, { host: "a;rm" }, { port: 70000 }, { username: "a b" }, { root: "relative" }, { auth: "magic" }, { name: "" }]) {
      await assert.rejects(createConnection({ name: "x", host: "nas.local", username: "alice", auth: "password", password: "p", ...bad }), /isn't valid|Enter the|must be|Choose how/, JSON.stringify(bad));
    }
    await assert.rejects(trustHostKey(connection.id, "not-a-fingerprint"), /fingerprint/);
  });
});

test("a server's identity must be confirmed, and a changed one is refused", async () => {
  await withServer(async ({ connect }) => {
    const id = await connect();
    assert.equal((await testConnection(id)).ok, true);
    await trustHostKey(id, `SHA256:${"B".repeat(43)}`);
    const changed = await testConnection(id).catch((error) => error);
    assert.equal(changed.code, "HOST_KEY_CHANGED");
    assert.match(changed.fingerprint, /^SHA256:/);
    // A wrong password is a clear sign-in failure.
    const wrong = await connect({ password: "wrong" }).catch((error) => error);
    assert.equal(wrong.code ?? (await testConnection((await listConnections()).at(-1)!.id).catch((error) => error)).code, "REMOTE_AUTH_FAILED");
  });
});

test("FilesDude can sign in with a key it generated", async () => {
  const keyed: { publicKey?: string } = {};
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-remote-key-")));
  const original = { stateDir: config.stateDir, sessionSecret: config.sessionSecret };
  Object.assign(config, { stateDir: base, sessionSecret: "remote-test-session-secret-with-more-than-32-characters" });
  const connection = await createConnection({ name: "Keyed", host: "127.0.0.1", username: "alice", auth: "key" });
  keyed.publicKey = connection.publicKey;
  const settingsFile = await fs.readFile(path.join(base, "connections.json"), "utf8");
  Object.assign(config, original);
  await withServer(async ({ state, port }) => {
    // The same stored connection, pointed at this server.
    const stored = JSON.parse(settingsFile);
    stored[0].port = port;
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "connections.json"), JSON.stringify(stored), { mode: 0o600 });
    const unknown = await testConnection(connection.id).catch((error) => error);
    await trustHostKey(connection.id, unknown.fingerprint);
    assert.equal((await testConnection(connection.id)).ok, true);
    await closeSession(connection.id);
  }, { publicKeys: [keyed.publicKey!] });
  await fs.rm(base, { recursive: true, force: true });
});

test("browsing, folders, renames, deletes, and reads on the server stay inside its starting folder", async () => {
  await withServer(async ({ remote, connect }) => {
    await write(remote, { "share/docs/a.txt": "hello world", "share/docs/b.txt": "bb", "outside.txt": "secret" });
    const id = await connect({ root: "/share" });
    const top = await listRemote(id, "");
    assert.equal(top.root, "/share");
    assert.deepEqual(top.entries.map((entry) => [entry.name, entry.type]), [["docs", "directory"]]);
    assert.deepEqual((await listRemote(id, "docs")).entries.map((entry) => entry.path).sort(), ["docs/a.txt", "docs/b.txt"]);
    await assert.rejects(listRemote(id, "../"), /Invalid path/);
    await assert.rejects(listRemote(id, "docs/../.."), /Invalid path/);
    assert.equal(await makeRemoteFolder(id, "docs", "new"), "docs/new");
    await assert.rejects(makeRemoteFolder(id, "docs", "new"), /already exists/);
    await assert.rejects(makeRemoteFolder(id, "docs", "a/b"), /without slashes/);
    assert.equal(await renameRemote(id, "docs/b.txt", "c.txt"), "docs/c.txt");
    const { stream } = await readRemote(id, "docs/a.txt", { start: 6, end: 10 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "world");
    assert.equal(await deleteRemote(id, ["docs"]), 4);
    await assert.rejects(deleteRemote(id, [""]), /starting folder/);
    assert.deepEqual(await fs.readdir(path.join(remote, "share")), []);
    assert.equal(await fs.readFile(path.join(remote, "outside.txt"), "utf8"), "secret");
  });
});

test("folders and files copy from a server into FilesDude, safely named and never half-done", async () => {
  await withServer(async ({ root, remote, connect }) => {
    await write(remote, { "photos/2024/beach.jpg": "sand", "photos/2024/sea.jpg": "water", "photos/notes.txt": "n", "photos/.filedude/x": "internal", "photos/bad\\name.txt": "skipped", "single.txt": "one" });
    await fs.symlink("/etc/passwd", path.join(remote, "photos/link"));
    await write(root, { "in/single.txt": "already here" });
    const id = await connect();
    const job = await startCopyFromServer(id, ["photos", "single.txt"], "in", () => undefined);
    const { state, failure } = await waitForJob(job.id);
    assert.equal(failure, undefined);
    assert.deepEqual(state.transferred!.map((item) => [item.path, item.renamed]), [["in/photos", false], ["in/single (1).txt", true]]);
    assert.equal(state.progress.done, state.progress.total);
    assert.deepEqual((await fs.readdir(path.join(root, "in"))).sort(), ["photos", "single (1).txt", "single.txt"]);
    assert.deepEqual((await fs.readdir(path.join(root, "in/photos"))).sort(), ["2024", "notes.txt"]);
    assert.equal(await fs.readFile(path.join(root, "in/photos/2024/sea.jpg"), "utf8"), "water");
    // A missing source fails the job and leaves no placeholder behind.
    const failed = await waitForJob((await startCopyFromServer(id, ["photos/nope"], "in", () => undefined)).id);
    assert.ok(failed.failure);
    assert.ok(!(await fs.readdir(path.join(root, "in"))).some((name) => name.startsWith(".filesdude-copying")));
  });
});

test("files and folders copy from FilesDude to a server, skipping links and internal folders", async () => {
  await withServer(async ({ root, remote, connect }) => {
    await write(root, { "album/a.jpg": "aaa", "album/sub/b.jpg": "bb", "album/.filedude/secret": "x", "song.mp3": "la" });
    await fs.symlink("/etc/passwd", path.join(root, "album/link"));
    await write(remote, { "backup/song.mp3": "old" });
    const id = await connect();
    const { state, failure } = await waitForJob((await startCopyToServer(id, ["album", "song.mp3"], "backup", () => undefined)).id);
    assert.equal(failure, undefined);
    assert.deepEqual(state.transferred!.map((item) => item.path), ["backup/album", "backup/song (1).mp3"]);
    assert.deepEqual((await fs.readdir(path.join(remote, "backup/album"))).sort(), ["a.jpg", "sub"]);
    assert.equal(await fs.readFile(path.join(remote, "backup/album/sub/b.jpg"), "utf8"), "bb");
    assert.equal(await fs.readFile(path.join(remote, "backup/song.mp3"), "utf8"), "old");
    assert.ok(!(await fs.readdir(path.join(remote, "backup"))).some((name) => name.startsWith(".filesdude")));
    // Into a folder that isn't there: the job fails cleanly.
    assert.ok((await waitForJob((await startCopyToServer(id, ["song.mp3"], "missing", () => undefined)).id)).failure);
    assert.equal((await getConnection(id)).name, "Backup box");
  });
});
