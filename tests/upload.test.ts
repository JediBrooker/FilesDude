import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { createSession } from "../lib/auth";
import { getCredentials } from "../lib/credentials";
import { withFilesystemLock } from "../lib/files";
import { POST as upload } from "../app/api/fs/upload/route";

const BOUNDARY = "filesdude-test-boundary";
const encoder = new TextEncoder();

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withUploadRoot<T>(run: (root: string, cookie: string) => Promise<T>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-upload-")));
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  const salt = crypto.randomBytes(16);
  config.root = root;
  config.stateDir = path.join(root, ".filedude");
  config.passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("upload-test-password", salt)).toString("base64url")}`;
  config.sessionSecret = "upload-test-session-secret-with-more-than-32-characters";
  try {
    const credentials = await getCredentials();
    return await run(root, `fd_session=${createSession(credentials.username, credentials.version)}`);
  } finally {
    Object.assign(config, original);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function partHeader(filename: string) {
  return encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
}

function uploadRequest(cookie: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request("http://localhost/api/fs/upload?path=", {
    method: "POST",
    headers: { cookie, "x-filedude-request": "1", "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    signal,
    duplex: "half",
  } as RequestInit);
}

function withinTime<T>(promise: Promise<T>, label: string, ms = 5_000) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms); }),
  ]);
}

const lockIsFree = () => withinTime(withFilesystemLock(async () => true), "Acquiring the filesystem lock");

test("a complete upload is written and answered", async () => {
  await withUploadRoot(async (root, cookie) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partHeader("hello.txt"));
        controller.enqueue(encoder.encode("hello"));
        controller.enqueue(encoder.encode(`\r\n--${BOUNDARY}--\r\n`));
        controller.close();
      },
    });
    const response = await withinTime(upload(uploadRequest(cookie, body)), "The upload");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).uploaded, ["hello.txt"]);
    assert.equal(await fs.readFile(path.join(root, "hello.txt"), "utf8"), "hello");
    assert.equal(await lockIsFree(), true);
  });
});

test("file names outside ASCII arrive intact", async () => {
  await withUploadRoot(async (root, cookie) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partHeader("Café 写真.txt"));
        controller.enqueue(encoder.encode("hello"));
        controller.enqueue(encoder.encode(`\r\n--${BOUNDARY}--\r\n`));
        controller.close();
      },
    });
    const response = await withinTime(upload(uploadRequest(cookie, body)), "The upload");
    assert.deepEqual((await response.json()).uploaded, ["Café 写真.txt"]);
    assert.equal(await fs.readFile(path.join(root, "Café 写真.txt"), "utf8"), "hello");
  });
});

test("an upload whose body fails part-way releases the lock and removes the partial file", async () => {
  await withUploadRoot(async (root, cookie) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partHeader("broken.bin"));
        controller.enqueue(new Uint8Array(64 * 1024));
        setTimeout(() => controller.error(new Error("connection reset")), 50);
      },
    });
    const response = await withinTime(upload(uploadRequest(cookie, body)), "The failed upload");
    assert.ok(response.status >= 400);
    assert.equal(await lockIsFree(), true);
    assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".")), []);
  });
});

test("a cancelled upload whose body stalls releases the lock and removes the partial file", async () => {
  await withUploadRoot(async (root, cookie) => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(partHeader("stalled.bin"));
        stream.enqueue(new Uint8Array(64 * 1024));
      },
    });
    setTimeout(() => controller.abort(), 100);
    const response = await withinTime(upload(uploadRequest(cookie, body, controller.signal)), "The cancelled upload");
    assert.ok(response.status >= 400);
    assert.equal(await lockIsFree(), true);
    assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".")), []);
  });
});
