import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeRelative } from "../lib/files";
import { verifyPassword } from "../lib/auth";
import { parseUploadOwnershipPreference } from "../lib/preferences";

const scrypt = promisify(crypto.scrypt);

test("normalizes safe paths without allowing traversal", () => {
  assert.equal(normalizeRelative("media//photos/../video"), "media/video");
  assert.equal(normalizeRelative("/documents"), "documents");
  assert.throws(() => normalizeRelative("../../etc/passwd"), /configured root/);
  assert.throws(() => normalizeRelative("hello\0world"), /Invalid path/);
});

test("verifies configured scrypt passwords with constant-length hashes", async () => {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt("correct horse battery staple", salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const encoded = `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
});

test("validates saved upload ownership preferences", () => {
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "destination" }), { mode: "destination" });
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "service" }), { mode: "service" });
  assert.deepEqual(parseUploadOwnershipPreference({ mode: "fixed", uid: 1000, gid: 1000 }), { mode: "fixed", uid: 1000, gid: 1000 });
  assert.throws(() => parseUploadOwnershipPreference({ mode: "fixed", uid: -1, gid: 1000 }), /valid default upload owner/);
  assert.throws(() => parseUploadOwnershipPreference({ mode: "fixed", uid: "0", gid: 0 }), /valid default upload owner/);
});
