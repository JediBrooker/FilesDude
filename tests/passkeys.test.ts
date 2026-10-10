import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearLoginFailures, createSession } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { currentStep, totpAt } from "../lib/totp";
import { createUser } from "../lib/users";
import { POST as passkeyLogin } from "../app/api/auth/passkey-login/route";
import { GET as listPasskeys, POST as passkeyAction } from "../app/api/auth/passkeys/route";
import { POST as twoFactorAction } from "../app/api/auth/two-factor/route";
import { POST as usersAction } from "../app/api/users/route";
import { SoftAuthenticator, type RegistrationOptions, type SignInOptions } from "./helpers/authenticator";

type Handler = (request: Request) => Promise<Response>;

const OWNER_PASSWORD = "owner-test-password-long";
const USER_PASSWORD = "user-test-password-long";
const ORIGIN = "http://localhost:3000";

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withAccounts<T>(run: (context: { owner: string; bob: string; bobId: string; base: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-passkeys-")));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "home", "bob"), { recursive: true });
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, username: config.username };
  Object.assign(config, {
    root,
    stateDir: path.join(base, "state"),
    username: "owner",
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt(OWNER_PASSWORD, salt)).toString("base64url")}`,
    sessionSecret: "passkeys-test-session-secret-with-more-than-32-characters",
  });
  clearLoginFailures("direct-client");
  try {
    const credentials = await getCredentials();
    const bob = await createUser({ username: "bob", password: USER_PASSWORD, role: "editor", root: "home/bob" });
    return await run({ owner: `fd_session=${createSession(credentials.username, credentials.version)}`, bob: `fd_session=${createSession("bob", 1, bob.id)}`, bobId: bob.id, base });
  } finally {
    clearLoginFailures("direct-client");
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

function call(handler: Handler, route: string, cookie: string, body?: unknown, origin = ORIGIN) {
  const url = new URL(route, origin);
  const headers: Record<string, string> = { host: url.host, origin, "x-filedude-request": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return handler(new Request(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function json<T = Record<string, unknown>>(response: Promise<Response> | Response) {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as T, cookie: resolved.headers.get("set-cookie") };
}

async function addPasskey(cookie: string, authenticator: SoftAuthenticator, extra: Record<string, unknown> = {}, name = "Laptop") {
  const options = await json<{ options: RegistrationOptions }>(call(passkeyAction, "/api/auth/passkeys", cookie, { action: "options", currentPassword: extra.password ?? OWNER_PASSWORD, code: extra.code }));
  assert.equal(options.status, 200, JSON.stringify(options.body));
  return json<{ passkey: { id: string; name: string; rpId: string }; passkeys: unknown[] }>(call(passkeyAction, "/api/auth/passkeys", cookie, { action: "register", response: authenticator.register(options.body.options, ORIGIN), name }));
}

async function signIn(authenticator: SoftAuthenticator, origin = ORIGIN, overrides: Parameters<SoftAuthenticator["signIn"]>[2] = {}) {
  const options = await json<{ challengeId: string; options: SignInOptions }>(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "options" }, origin));
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const response = authenticator.signIn(options.body.options, origin, overrides);
  const result = await json<{ authenticated?: boolean; username?: string; code?: string }>(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "verify", challengeId: options.body.challengeId, response }, origin));
  return { ...result, challengeId: options.body.challengeId, response };
}

const sessionFrom = (setCookie: string | null) => (setCookie ?? "").split(";")[0];

test("an account adds a passkey with its password and signs in with it, without a username", async () => {
  await withAccounts(async ({ owner }) => {
    const authenticator = new SoftAuthenticator({ counting: true });
    const wrong = await json(call(passkeyAction, "/api/auth/passkeys", owner, { action: "options", currentPassword: "not-the-password" }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, "INVALID_CURRENT_PASSWORD");

    const added = await addPasskey(owner, authenticator, {}, "Work\u0000 laptop\u202e");
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.passkey.name, "Work laptop");
    assert.equal(added.body.passkey.rpId, "localhost");
    const stored = JSON.parse(await fs.readFile(path.join(config.stateDir, "passkeys.json"), "utf8"));
    assert.equal(stored.length, 1);
    assert.equal((await fs.stat(path.join(config.stateDir, "passkeys.json"))).mode & 0o777, 0o600);

    const signedIn = await signIn(authenticator);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.username, "owner");
    const session = sessionFrom(signedIn.cookie);
    const listed = await json<{ passkeys: { lastUsedAt: string | null }[] }>(call(listPasskeys, "/api/auth/passkeys", session));
    assert.equal(listed.status, 200);
    assert.ok(listed.body.passkeys[0].lastUsedAt);

    // The same signed response can't be used twice, with its challenge or with a new one.
    const replay = await json(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "verify", challengeId: signedIn.challengeId, response: signedIn.response }));
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, "PASSKEY_EXPIRED");
    const fresh = await json<{ challengeId: string }>(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "options" }));
    const reused = await json(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "verify", challengeId: fresh.body.challengeId, response: signedIn.response }));
    assert.equal(reused.status, 401);
    assert.equal(reused.body.code, "PASSKEY_INVALID");
  });
});

test("passkey sign-in refuses other keys, other accounts' handles, other addresses, and old counters", async () => {
  await withAccounts(async ({ owner, bob }) => {
    const authenticator = new SoftAuthenticator({ counting: true });
    assert.equal((await addPasskey(owner, authenticator)).status, 200);
    const bobKey = new SoftAuthenticator();
    assert.equal((await addPasskey(bob, bobKey, { password: USER_PASSWORD })).status, 200);

    // A different key presenting the registered credential's id.
    const impostor = new SoftAuthenticator();
    Object.defineProperty(impostor, "credentialId", { value: authenticator.credentialId });
    impostor.userHandle = authenticator.userHandle;
    impostor.rpId = "localhost";
    assert.equal((await signIn(impostor)).status, 401);
    clearLoginFailures("direct-client");

    // The owner's passkey claiming to be Bob's account.
    assert.equal((await signIn(authenticator, ORIGIN, { userHandle: bobKey.userHandle })).status, 401);
    // Signed for a different relying party.
    assert.equal((await signIn(authenticator, ORIGIN, { rpId: "evil.example" })).status, 401);
    clearLoginFailures("direct-client");
    // Added on localhost, so another address (even a subdomain) doesn't know it.
    assert.equal((await signIn(authenticator, "http://files.localhost:3000")).status, 401);
    // Passkeys need HTTPS anywhere but localhost.
    const insecure = await json(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "options" }, "http://files.example.com"));
    assert.equal(insecure.status, 400);
    assert.equal(insecure.body.code, "PASSKEY_UNAVAILABLE");
    clearLoginFailures("direct-client");

    const good = await signIn(authenticator);
    assert.equal(good.status, 200, JSON.stringify(good.body));
    // A cloned key whose counter went backwards.
    authenticator.counter -= 3;
    assert.equal((await signIn(authenticator)).status, 401);
    authenticator.counter += 10;
    assert.equal((await signIn(authenticator)).status, 200);

    // A passkey without user verification (no PIN or biometric) isn't accepted.
    const unverified = new SoftAuthenticator({ userVerified: false });
    const options = await json<{ options: RegistrationOptions }>(call(passkeyAction, "/api/auth/passkeys", owner, { action: "options", currentPassword: OWNER_PASSWORD }));
    const register = await json(call(passkeyAction, "/api/auth/passkeys", owner, { action: "register", response: unverified.register(options.body.options, ORIGIN) }));
    assert.equal(register.status, 400);
  });
});

test("failed passkey sign-ins count towards the sign-in limit", async () => {
  await withAccounts(async () => {
    const stranger = new SoftAuthenticator();
    stranger.rpId = "localhost";
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await signIn(stranger)).status, 401);
    const options = await json(call(passkeyLogin, "/api/auth/passkey-login", "", { action: "options" }));
    assert.equal(options.status, 429);
  });
});

test("accounts manage only their own passkeys, and adding one with two-factor sign-in needs a code", async () => {
  await withAccounts(async ({ owner, bob }) => {
    const ownerKey = new SoftAuthenticator();
    const added = await addPasskey(owner, ownerKey);
    const id = added.body.passkey.id;
    assert.equal((await json(call(passkeyAction, "/api/auth/passkeys", bob, { action: "remove", id }))).status, 404);
    assert.equal((await json(call(passkeyAction, "/api/auth/passkeys", bob, { action: "rename", id, name: "mine now" }))).status, 404);
    assert.deepEqual((await json<{ passkeys: unknown[] }>(call(listPasskeys, "/api/auth/passkeys", bob))).body.passkeys, []);
    const renamed = await json<{ passkey: { name: string } }>(call(passkeyAction, "/api/auth/passkeys", owner, { action: "rename", id, name: "Desk" }));
    assert.equal(renamed.body.passkey.name, "Desk");

    // Bob turns on two-factor sign-in; adding a passkey then needs a code as well.
    const setup = await json<{ secret: string; setupToken: string }>(call(twoFactorAction, "/api/auth/two-factor", bob, { action: "setup", currentPassword: USER_PASSWORD }));
    const step = currentStep();
    const enabled = await json(call(twoFactorAction, "/api/auth/two-factor", bob, { action: "enable", setupToken: setup.body.setupToken, code: totpAt(setup.body.secret, step) }));
    assert.equal(enabled.status, 200);
    const bobSession = sessionFrom(enabled.cookie);
    const withoutCode = await json(call(passkeyAction, "/api/auth/passkeys", bobSession, { action: "options", currentPassword: USER_PASSWORD }));
    assert.equal(withoutCode.status, 401);
    assert.equal(withoutCode.body.code, "INVALID_TWO_FACTOR_CODE");
    const bobKey = new SoftAuthenticator();
    const bobAdded = await addPasskey(bobSession, bobKey, { password: USER_PASSWORD, code: totpAt(setup.body.secret, step + 1) });
    assert.equal(bobAdded.status, 200, JSON.stringify(bobAdded.body));
    // A passkey signs in without the code.
    const signedIn = await signIn(bobKey);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.username, "bob");

    // Removing one needs only the session.
    assert.equal((await json(call(passkeyAction, "/api/auth/passkeys", owner, { action: "remove", id }))).status, 200);
    assert.equal((await signIn(ownerKey)).status, 401);
  });
});

test("an owner's password reset or deletion of an account removes its passkeys", async () => {
  await withAccounts(async ({ owner, bob, bobId }) => {
    const bobKey = new SoftAuthenticator();
    assert.equal((await addPasskey(bob, bobKey, { password: USER_PASSWORD })).status, 200);
    const ownerKey = new SoftAuthenticator();
    assert.equal((await addPasskey(owner, ownerKey)).status, 200);
    // A role change keeps them.
    assert.equal((await json(call(usersAction, "/api/users", owner, { action: "update", id: bobId, role: "viewer" }))).status, 200);
    assert.equal((await signIn(bobKey)).status, 200);
    assert.equal((await json(call(usersAction, "/api/users", owner, { action: "update", id: bobId, password: "brand-new-password-long" }))).status, 200);
    assert.equal((await signIn(bobKey)).status, 401);
    clearLoginFailures("direct-client");

    const again = new SoftAuthenticator();
    const bobSession = `fd_session=${createSession("bob", 3, bobId)}`;
    assert.equal((await addPasskey(bobSession, again, { password: "brand-new-password-long" })).status, 200);
    assert.equal((await json(call(usersAction, "/api/users", owner, { action: "delete", id: bobId }))).status, 200);
    assert.equal((await signIn(again)).status, 401);
    const stored = JSON.parse(await fs.readFile(path.join(config.stateDir, "passkeys.json"), "utf8")) as { account: string }[];
    assert.deepEqual(stored.map((passkey) => passkey.account), ["owner"]);
    assert.equal((await signIn(ownerKey)).status, 200);
  });
});
