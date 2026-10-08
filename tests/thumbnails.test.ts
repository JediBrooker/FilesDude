import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { thumbnailFor } from "../lib/thumbnails";
import { GET as checksum } from "../app/api/fs/checksum/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (root: string, cookie: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-thumbs-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  Object.assign(config, {
    root,
    stateDir: path.join(base, "state"),
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("thumbnail-test-password", salt)).toString("base64url")}`,
    sessionSecret: "thumbnail-test-session-secret-with-more-than-32-characters",
  });
  try {
    const credentials = await getCredentials();
    return await run(root, `fd_session=${createSession(credentials.username, credentials.version)}`);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 90 } } });

test("thumbnails are small WebP previews, cached until the image changes", async () => {
  await withRoot(async (root) => {
    await image(2000, 1000).png().toFile(path.join(root, "wide.png"));
    const first = await thumbnailFor("wide.png");
    const meta = await sharp(first).metadata();
    assert.equal(meta.format, "webp");
    assert.deepEqual([meta.width, meta.height], [320, 160]);
    const cacheFiles = await fs.readdir(path.join(config.stateDir, "thumbnails"));
    assert.equal(cacheFiles.length, 1);
    assert.ok((await thumbnailFor("wide.png")).equals(first));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await image(100, 400).png().toFile(path.join(root, "wide.png"));
    const changed = await sharp(await thumbnailFor("wide.png")).metadata();
    assert.deepEqual([changed.width, changed.height], [80, 320]);
  });
});

test("thumbnails follow EXIF orientation and drop all metadata", async () => {
  await withRoot(async (root) => {
    await image(600, 300).jpeg().withExif({ IFD0: { Make: "Camera", Model: "Secret Model" } }).withMetadata({ orientation: 6 }).toFile(path.join(root, "photo.jpg"));
    const meta = await sharp(await thumbnailFor("photo.jpg")).metadata();
    assert.deepEqual([meta.width, meta.height], [160, 320]);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.orientation, undefined);
  });
});

test("unsupported, oversized, corrupt, and reserved images get no thumbnail", async () => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, "vector.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await fs.writeFile(path.join(root, "notes.txt"), "text");
    await fs.writeFile(path.join(root, "broken.png"), "not really a png");
    const huge = await fs.open(path.join(root, "huge.png"), "w");
    await huge.truncate(65 * 1024 * 1024);
    await huge.close();
    await fs.mkdir(path.join(root, ".filedude"));
    await image(10, 10).png().toFile(path.join(root, ".filedude", "x.png"));
    await assert.rejects(thumbnailFor("vector.svg"), /no thumbnail/);
    await assert.rejects(thumbnailFor("notes.txt"), /no thumbnail/);
    await assert.rejects(thumbnailFor("huge.png"), /too large/);
    await assert.rejects(thumbnailFor("broken.png"), /couldn't be read/);
    await assert.rejects(thumbnailFor(".filedude/x.png"), /reserved/);
  });
});

test("checksums report SHA-256 and MD5 for files only", async () => {
  await withRoot(async (root, cookie) => {
    await fs.writeFile(path.join(root, "abc.txt"), "abc");
    await fs.mkdir(path.join(root, "folder"));
    const request = (target: string) => checksum(new Request(`http://localhost/api/fs/checksum?path=${encodeURIComponent(target)}`, { headers: { cookie } }));
    const response = await request("abc.txt");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      md5: "900150983cd24fb0d6963f7d28e17f72",
      bytes: 3,
    });
    assert.equal((await request("folder")).status, 400);
    assert.equal((await request(".filedude/x")).status, 403);
    assert.equal((await checksum(new Request("http://localhost/api/fs/checksum?path=abc.txt"))).status, 401);
  });
});
