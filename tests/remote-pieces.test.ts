import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Session } from "../lib/auth";
import { config } from "../lib/config";
import { createConnection, trustHostKey } from "../lib/connections";
import { appendRemoteChunk, cancelConnectionUploads, cancelRemoteUpload, finishRemoteUpload, remoteUploadStatus, startRemoteUpload } from "../lib/remote-pieces";
import { closeSession, testConnection } from "../lib/sftp";
import { startSftpServer } from "./helpers/sftp-server";

const PASSWORD = "remote-pieces-test-password";
const owner: Session = { username: "owner", credentialsVersion: 1, accountKey: "owner", role: "owner", root: "" };

async function withServer<T>(run: (context: { remote: string; id: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-remote-pieces-")));
  const remote = path.join(base, "remote");
  await fs.mkdir(path.join(remote, "backups"), { recursive: true });
  await fs.mkdir(path.join(base, "root"));
  const original = { root: config.root, stateDir: config.stateDir, sessionSecret: config.sessionSecret, maxUploadBytes: config.maxUploadBytes };
  Object.assign(config, { root: path.join(base, "root"), stateDir: path.join(base, "state"), sessionSecret: "remote-pieces-test-session-secret-with-32-chars", maxUploadBytes: 16 * 1024 * 1024 });
  const server = await startSftpServer(remote, { username: "alice", password: PASSWORD });
  const connection = await createConnection({ name: "Box", host: "127.0.0.1", port: server.port, username: "alice", auth: "password", password: PASSWORD });
  const unknown = await testConnection(connection.id).catch((error) => error);
  await trustHostKey(connection.id, unknown.fingerprint);
  try {
    return await run({ remote, id: connection.id });
  } finally {
    await closeSession(connection.id);
    await server.close();
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const stream = (data: Buffer) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(data)); controller.close(); } });
const send = (id: string, offset: number, data: Buffer, declared: number | null = data.length) => appendRemoteChunk(owner, id, offset, declared, stream(data), new AbortController().signal);

test("a large file goes to another server in pieces and takes a free name there", async () => {
  await withServer(async ({ remote, id }) => {
    await fs.writeFile(path.join(remote, "backups", "disk.img"), "theirs");
    const data = crypto.randomBytes(3 * 1024 * 1024 + 5);
    const started = await startRemoteUpload(owner, id, "backups", "disk.img", data.length);
    const hidden = (await fs.readdir(path.join(remote, "backups"))).filter((name) => name.startsWith(".filesdude-upload-"));
    assert.equal(hidden.length, 1);
    const size = 1024 * 1024;
    for (let offset = 0; offset < data.length; offset += size) assert.equal((await send(started.id, offset, data.subarray(offset, offset + size))).received, Math.min(data.length, offset + size));
    // Out of step, early, or past the end is refused.
    await assert.rejects(send(started.id, 0, Buffer.from("x")), /isn't the next one/);
    assert.deepEqual(remoteUploadStatus(owner, started.id), { received: data.length, size: data.length });
    const done = await finishRemoteUpload(owner, started.id);
    assert.equal(done.name, "disk (1).img");
    assert.ok((await fs.readFile(path.join(remote, "backups", "disk (1).img"))).equals(data));
    assert.equal(await fs.readFile(path.join(remote, "backups", "disk.img"), "utf8"), "theirs");
    assert.deepEqual((await fs.readdir(path.join(remote, "backups"))).sort(), ["disk (1).img", "disk.img"]);
    assert.throws(() => remoteUploadStatus(owner, started.id), /expired or was cancelled/);
  });
});

test("remote uploads in pieces recover from a cut-off piece and can be cancelled", async () => {
  await withServer(async ({ remote, id }) => {
    await assert.rejects(startRemoteUpload(owner, id, "backups", "huge.bin", 17 * 1024 * 1024), /configured limit/);
    await assert.rejects(startRemoteUpload(owner, id, "../outside", "a.bin", 10), /Invalid path/);
    const started = await startRemoteUpload(owner, id, "backups", "a.bin", 100);
    assert.equal((await send(started.id, 0, Buffer.alloc(40, 1))).received, 40);
    // A piece that says 50 bytes but sends 20 is cut back off.
    await assert.rejects(send(started.id, 40, Buffer.alloc(20, 2), 50), /ended early/);
    assert.equal(remoteUploadStatus(owner, started.id).received, 40);
    const temporary = (await fs.readdir(path.join(remote, "backups"))).find((name) => name.startsWith(".filesdude-upload-"))!;
    assert.equal((await fs.stat(path.join(remote, "backups", temporary))).size, 40);
    assert.equal((await send(started.id, 40, Buffer.alloc(60, 3))).received, 100);
    await assert.rejects(finishRemoteUpload({ ...owner, credentialsVersion: 2 }, started.id), /expired or was cancelled/);
    await cancelRemoteUpload(owner, started.id);
    assert.deepEqual(await fs.readdir(path.join(remote, "backups")), []);

    // Changing or removing the server ends its uploads at once; the temporary file goes in the background.
    const other = await startRemoteUpload(owner, id, "backups", "b.bin", 10);
    cancelConnectionUploads(id);
    assert.throws(() => remoteUploadStatus(owner, other.id), /expired or was cancelled/);
    for (let attempt = 0; attempt < 50 && (await fs.readdir(path.join(remote, "backups"))).length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await fs.readdir(path.join(remote, "backups")), []);

    // Cancelling while a piece is arriving stops it and removes the upload once it has stopped.
    const slow = await startRemoteUpload(owner, id, "backups", "c.bin", 100);
    let push!: (data: Uint8Array) => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) { push = (data) => controller.enqueue(data); } });
    const arriving = appendRemoteChunk(owner, slow.id, 0, 100, body, new AbortController().signal);
    push(new Uint8Array(10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cancelRemoteUpload(owner, slow.id);
    await assert.rejects(arriving);
    assert.throws(() => remoteUploadStatus(owner, slow.id), /expired or was cancelled/);
    assert.deepEqual(await fs.readdir(path.join(remote, "backups")), []);

    // The file keeps the mode it was created with (pieces don't reset it).
    const moded = await startRemoteUpload(owner, id, "backups", "d.bin", 4);
    await send(moded.id, 0, Buffer.from("data"));
    await finishRemoteUpload(owner, moded.id);
    assert.equal((await fs.stat(path.join(remote, "backups", "d.bin"))).mode & 0o777, 0o644);
  });
});
