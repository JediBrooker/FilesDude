import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isValidPasswordHash } from "../lib/config";
import { formatLogin, hashPassword, missingFromEnvironment, newSecret, parseLogin, readLogin, writeLogin } from "../docker/filesdude.mjs";

test("the Docker image's saved login is read back as written, and nothing else in it is read", () => {
  const values = { FILEDUDE_USERNAME: "owner", FILEDUDE_PASSWORD_HASH: "scrypt$16384$8$1$c2FsdA$aGFzaA", FILEDUDE_SESSION_SECRET: "a+b/c==", FILEDUDE_SESSION_EPOCH: "2" };
  assert.deepEqual(parseLogin(formatLogin(values)), values);
  // Other settings, comments, and empty values are ignored; a value keeps its own equals signs.
  assert.deepEqual(parseLogin("FILEDUDE_ROOT=/\nNODE_OPTIONS=--require=/state/x.js\n# FILEDUDE_USERNAME=commented\nFILEDUDE_USERNAME=\nFILEDUDE_SESSION_SECRET=x==y\n"), { FILEDUDE_SESSION_SECRET: "x==y" });
  assert.equal(formatLogin({ FILEDUDE_USERNAME: "owner", NODE_OPTIONS: "--inspect" }), "FILEDUDE_USERNAME=owner\n");
});

test("the container's own environment wins over the saved login", () => {
  const saved = { FILEDUDE_USERNAME: "saved", FILEDUDE_PASSWORD_HASH: "saved-hash", FILEDUDE_SESSION_SECRET: "saved-secret" };
  assert.deepEqual(missingFromEnvironment(saved, { FILEDUDE_USERNAME: "configured", FILEDUDE_SESSION_SECRET: "" }), { FILEDUDE_PASSWORD_HASH: "saved-hash", FILEDUDE_SESSION_SECRET: "saved-secret" });
  assert.deepEqual(missingFromEnvironment({}, {}), {});
});

test("the saved login is private to FilesDude's account and replaced whole", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "filesdude-login-"));
  try {
    assert.deepEqual(readLogin(stateDir), {});
    writeLogin(stateDir, { FILEDUDE_USERNAME: "first", FILEDUDE_SESSION_SECRET: "one" });
    writeLogin(stateDir, { FILEDUDE_USERNAME: "second" });
    assert.deepEqual(readLogin(stateDir), { FILEDUDE_USERNAME: "second" });
    assert.equal(fs.statSync(path.join(stateDir, "login.env")).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(stateDir), ["login.env"]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("setup's password hashes and secrets are ones FilesDude accepts", async () => {
  assert.equal(isValidPasswordHash(await hashPassword("a long enough password")), true);
  assert.ok(newSecret().length >= 32);
  assert.notEqual(newSecret(), newSecret());
});
