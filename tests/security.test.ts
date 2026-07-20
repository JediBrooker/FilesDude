import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeRelative, safeResolve, verifyFileHandleWithinRoot } from "../lib/files";
import { createSession, verifyPassword } from "../lib/auth";
import { config, configurationIssues, EXAMPLE_PASSWORD_HASH, EXAMPLE_SESSION_SECRET, isValidPasswordHash } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { AppError, readJsonBody } from "../lib/http";
import { parseUploadOwnershipPreference } from "../lib/preferences";
import { GET as download } from "../app/api/fs/download/route";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function generatedPasswordHash(password = "correct horse battery staple") {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

test("normalizes safe paths without allowing traversal", () => {
  assert.equal(normalizeRelative("media//photos/../video"), "media/video");
  assert.equal(normalizeRelative("/documents"), "documents");
  assert.throws(() => normalizeRelative("../../etc/passwd"), /configured root/);
  assert.throws(() => normalizeRelative("hello\0world"), /Invalid path/);
});

test("verifies configured scrypt passwords with constant-length hashes", async () => {
  const encoded = await generatedPasswordHash();
  assert.equal(isValidPasswordHash(encoded), true);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
  assert.equal(isValidPasswordHash(EXAMPLE_PASSWORD_HASH), false);
  assert.equal(await verifyPassword("anything", EXAMPLE_PASSWORD_HASH), false);
});

test("rejects example credentials as an incomplete configuration", async () => {
  const original = { passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  try {
    config.passwordHash = EXAMPLE_PASSWORD_HASH;
    config.sessionSecret = EXAMPLE_SESSION_SECRET;
    const issues = configurationIssues();
    assert.ok(issues.some((issue) => issue.includes("PASSWORD_HASH")));
    assert.ok(issues.some((issue) => issue.includes("SESSION_SECRET")));
  } finally {
    config.passwordHash = original.passwordHash;
    config.sessionSecret = original.sessionSecret;
  }
});

test("bounds JSON request bodies even without a content-length header", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(256) }),
  });
  await assert.rejects(
    () => readJsonBody(request, 64),
    (error: unknown) => error instanceof AppError && error.code === "REQUEST_TOO_LARGE",
  );
});

test("re-checks the opened file handle after pathname validation", async () => {
  const id = crypto.randomUUID();
  const inside = path.join(config.root, `.security-${id}`);
  const outside = path.join(os.tmpdir(), `filesdude-security-${id}`);
  const link = path.join(inside, "link");
  let handle: FileHandle | undefined;
  try {
    await fs.mkdir(path.join(inside, "safe"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(inside, "safe", "value.txt"), "inside");
    await fs.writeFile(path.join(outside, "value.txt"), "outside");
    await fs.symlink(path.join(inside, "safe"), link);
    const checked = await safeResolve(`${path.basename(inside)}/link/value.txt`);
    await fs.unlink(link);
    await fs.symlink(outside, link);
    handle = await fs.open(checked, "r");
    await assert.rejects(() => verifyFileHandleWithinRoot(handle!, checked), /configured root/);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(inside, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("directory downloads omit the protected state directory", async () => {
  const id = crypto.randomUUID();
  const publicDirectory = path.join(config.root, `archive-${id}`);
  const stateDirectory = path.join(config.root, `state-${id}`);
  const original = { passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, stateDir: config.stateDir };
  try {
    config.passwordHash = await generatedPasswordHash("archive-test-password");
    config.sessionSecret = "archive-test-session-secret-with-more-than-32-characters";
    config.stateDir = stateDirectory;
    await fs.mkdir(publicDirectory, { recursive: true });
    await fs.mkdir(stateDirectory, { recursive: true });
    const publicName = `public-${id}.txt`;
    const privateName = `private-${id}.txt`;
    await fs.writeFile(path.join(publicDirectory, publicName), "public");
    await fs.writeFile(path.join(stateDirectory, privateName), "private");
    const credentials = await getCredentials();
    const token = createSession(credentials.username, credentials.version);
    const response = await download(new Request("http://localhost/api/fs/download?path=", {
      headers: { cookie: `fd_session=${token}` },
    }));
    assert.equal(response.status, 200);
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    assert.equal(archiveBytes.includes(Buffer.from(publicName)), true);
    assert.equal(archiveBytes.includes(Buffer.from(privateName)), false);
  } finally {
    config.passwordHash = original.passwordHash;
    config.sessionSecret = original.sessionSecret;
    config.stateDir = original.stateDir;
    await fs.rm(publicDirectory, { recursive: true, force: true });
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("validates saved upload ownership preferences", () => {
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "destination" }), { mode: "destination" });
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "service" }), { mode: "service" });
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "fixed", uid: 1000, gid: 1000 }), { mode: "fixed", uid: 1000, gid: 1000 });
  assert.throws(() => parseUploadOwnershipPreference({ mode: "fixed", uid: -1, gid: 1000 }), /valid default upload owner/);
  assert.throws(() => parseUploadOwnershipPreference({ mode: "fixed", uid: "0", gid: 0 }), /valid default upload owner/);
});
