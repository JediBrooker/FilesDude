import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearLoginFailures, createSession, getSession, signOutEverywhere, STAY_SIGNED_IN_DAYS } from "../lib/auth";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { currentStep, generateSecret, totpAt } from "../lib/totp";
import { changeOwnPassword, createUser, findUserById, updateUserAccount } from "../lib/users";
import { POST as login } from "../app/api/auth/login/route";
import { GET as readSession, POST as sessionAction } from "../app/api/auth/session/route";
import { GET as authStatus } from "../app/api/auth/status/route";

const OWNER_PASSWORD = "owner-stay-password-long";
const USER_PASSWORD = "user-stay-password-long";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withAccounts<T>(run: (context: { bobId: string }) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-stay-")));
  await fs.mkdir(path.join(base, "root", "bob"), { recursive: true });
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, username: config.username, sessionHours: config.sessionHours, sessionEpoch: config.sessionEpoch };
  Object.assign(config, {
    root: path.join(base, "root"),
    stateDir: path.join(base, "state"),
    username: "owner",
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt(OWNER_PASSWORD, salt)).toString("base64url")}`,
    sessionSecret: "stay-signed-in-test-session-secret-with-plenty-of-characters",
    sessionHours: 12,
    sessionEpoch: "",
  });
  try {
    const bob = await createUser({ username: "bob", password: USER_PASSWORD, role: "editor", root: "bob" });
    return await run({ bobId: bob.id });
  } finally {
    Object.assign(config, original);
    clearLoginFailures("direct-client");
    await fs.rm(base, { recursive: true, force: true });
  }
}

const json = { "content-type": "application/json", "x-filedude-request": "1" };
const signIn = (username: string, password: string) => login(new Request("http://localhost/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username, password }) }));
const post = (cookie: string, body: unknown) => sessionAction(new Request("http://localhost/api/auth/session", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify(body) }));
const info = async (cookie: string) => (await readSession(new Request("http://localhost/api/auth/session", { headers: { cookie } }))).json() as Promise<{ staySignedIn: boolean; twoFactor: boolean; thisDevice: { staysSignedIn: boolean; signedInAt: string; expiresAt: string } }>;
const status = async (cookie: string) => {
  const response = await authStatus(new Request("http://localhost/api/auth/status", { headers: { cookie } }));
  return { authenticated: ((await response.json()) as { authenticated: boolean }).authenticated, setCookie: response.headers.get("set-cookie") };
};

/** The session cookie a response sets (as a request's Cookie header), and how long it lasts. */
function cookieOf(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /^(fd_session=[^;]+);.*Max-Age=(\d+)/.exec(header);
  assert.ok(match, `expected a session cookie, got "${header}"`);
  return { cookie: match[1], maxAge: Number(match[2]) };
}

const payloadOf = (cookie: string) => JSON.parse(Buffer.from(cookie.slice("fd_session=".length).split(".")[0], "base64url").toString("utf8"));

/** Runs `make` as if it were `ago` milliseconds ago. */
function madeAgo<T>(ago: number, make: () => T) {
  const realNow = Date.now;
  Date.now = () => realNow() - ago;
  try {
    return make();
  } finally {
    Date.now = realNow;
  }
}

test("sessions last FILEDUDE_SESSION_HOURS from sign-in unless the account stays signed in", async () => {
  await withAccounts(async () => {
    const signedIn = await signIn("owner", OWNER_PASSWORD);
    assert.equal(signedIn.status, 200);
    const { cookie, maxAge } = cookieOf(signedIn);
    assert.ok(maxAge > 12 * 3600 - 5 && maxAge <= 12 * 3600);
    // Checking in doesn't renew it.
    assert.deepEqual(await status(cookie), { authenticated: true, setCookie: null });
    const shown = await info(cookie);
    assert.equal(shown.staySignedIn, false);
    assert.equal(shown.thisDevice.staysSignedIn, false);

    // A session past its hours has ended, even one whose token says it lasts longer.
    const credentials = await getCredentials();
    const old = `fd_session=${madeAgo(13 * HOUR, () => createSession("owner", credentials.version))}`;
    assert.equal((await status(old)).authenticated, false);
    const claimsLonger = `fd_session=${createSession("owner", credentials.version, "owner", { staySignedIn: true, signedInAt: Date.now() - 13 * HOUR })}`;
    assert.equal((await status(claimsLonger)).authenticated, false);
  });
});

test("sessions made before staying signed in existed still work until they would have ended", async () => {
  await withAccounts(async () => {
    const credentials = await getCredentials();
    const legacy = (exp: number) => {
      const payload = Buffer.from(JSON.stringify({ u: "owner", k: "owner", v: credentials.version, exp, nonce: "n" })).toString("base64url");
      return `fd_session=${payload}.${crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url")}`;
    };
    assert.equal((await status(legacy(Date.now() + 6 * HOUR))).authenticated, true);
    assert.equal((await status(legacy(Date.now() - 1000))).authenticated, false);
  });
});

test("turning on staying signed in needs the current password and keeps this device signed in", async () => {
  await withAccounts(async () => {
    const { cookie } = cookieOf(await signIn("owner", OWNER_PASSWORD));
    const signedInAt = payloadOf(cookie).iat;

    for (const currentPassword of [undefined, "", "not-the-password"]) {
      assert.equal((await post(cookie, { action: "stay", staySignedIn: true, currentPassword })).status, 401);
    }
    assert.equal((await getCredentials()).staySignedIn, undefined);

    const turnedOn = await post(cookie, { action: "stay", staySignedIn: true, currentPassword: OWNER_PASSWORD });
    assert.equal(turnedOn.status, 200);
    const kept = cookieOf(turnedOn);
    assert.ok(kept.maxAge > (STAY_SIGNED_IN_DAYS * DAY) / 1000 - 5);
    // It's the same device's session: when it signed in is kept.
    assert.equal(payloadOf(kept.cookie).iat, signedInAt);
    assert.equal((await getCredentials()).staySignedIn, true);
    const shown = await info(kept.cookie);
    assert.equal(shown.staySignedIn, true);
    assert.equal(shown.thisDevice.staysSignedIn, true);

    // Signing in again now gives a long session straight away.
    assert.ok(cookieOf(await signIn("owner", OWNER_PASSWORD)).maxAge > (STAY_SIGNED_IN_DAYS * DAY) / 1000 - 5);

    // A device signed in before it was turned on keeps its short session (nothing renews it) until
    // the password is given there too.
    assert.deepEqual(await status(cookie), { authenticated: true, setCookie: null });
    assert.equal((await info(cookie)).thisDevice.staysSignedIn, false);
  });
});

test("a session that stays signed in is renewed once a day as the page checks in", async () => {
  await withAccounts(async () => {
    const { cookie } = cookieOf(await signIn("owner", OWNER_PASSWORD));
    const kept = cookieOf(await post(cookie, { action: "stay", staySignedIn: true, currentPassword: OWNER_PASSWORD })).cookie;
    // Fresh: nothing to renew.
    assert.deepEqual(await status(kept), { authenticated: true, setCookie: null });

    // Made two days ago (and signed in long before that): renewed for another full stretch, still
    // counting from the original sign-in.
    const { version } = await getCredentials();
    const signedInAt = Date.now() - 20 * DAY;
    const twoDaysOld = `fd_session=${madeAgo(2 * DAY, () => createSession("owner", version, "owner", { staySignedIn: true, signedInAt }))}`;
    const checked = await status(twoDaysOld);
    assert.equal(checked.authenticated, true);
    const renewed = /^(fd_session=[^;]+);.*Max-Age=(\d+)/.exec(checked.setCookie ?? "");
    assert.ok(renewed, "expected a renewed cookie");
    assert.ok(Number(renewed[2]) > (STAY_SIGNED_IN_DAYS * DAY) / 1000 - 5);
    assert.equal(payloadOf(renewed[1]).iat, signedInAt);
    assert.equal(payloadOf(renewed[1]).s, 1);

    // Unused for longer than the limit: signed out.
    const abandoned = `fd_session=${madeAgo((STAY_SIGNED_IN_DAYS + 1) * DAY, () => createSession("owner", version, "owner", { staySignedIn: true }))}`;
    assert.equal((await status(abandoned)).authenticated, false);
  });
});

test("turning staying signed in off signs out the other devices and gives this one a fresh session", async () => {
  await withAccounts(async () => {
    const { cookie } = cookieOf(await signIn("owner", OWNER_PASSWORD));
    const here = cookieOf(await post(cookie, { action: "stay", staySignedIn: true, currentPassword: OWNER_PASSWORD })).cookie;
    const phone = cookieOf(await signIn("owner", OWNER_PASSWORD)).cookie;
    const versionBefore = (await getCredentials()).version;

    // It takes the password: a cookie alone can't sign the others out.
    for (const currentPassword of [undefined, "not-the-password"]) {
      assert.equal((await post(here, { action: "stay", staySignedIn: false, currentPassword })).status, 401);
    }
    assert.equal((await getCredentials()).version, versionBefore);
    assert.equal((await status(phone)).authenticated, true);

    const turnedOff = await post(here, { action: "stay", staySignedIn: false, currentPassword: OWNER_PASSWORD });
    assert.equal(turnedOff.status, 200);
    const fresh = cookieOf(turnedOff);
    assert.ok(fresh.maxAge > 12 * 3600 - 5 && fresh.maxAge <= 12 * 3600);
    assert.equal(payloadOf(fresh.cookie).s, undefined);
    const stored = await getCredentials();
    assert.equal(stored.staySignedIn, undefined);
    assert.equal(stored.version, versionBefore + 1);
    assert.equal((await status(phone)).authenticated, false);
    assert.equal((await status(here)).authenticated, false);
    assert.equal((await status(fresh.cookie)).authenticated, true);

    // Turning it off again changes nothing and gives no new session (so it can't stretch one).
    const again = await post(fresh.cookie, { action: "stay", staySignedIn: false, currentPassword: OWNER_PASSWORD });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("set-cookie"), null);
    assert.equal((await getCredentials()).version, versionBefore + 1);
  });
});

test("signing out other devices keeps this one as it was", async () => {
  await withAccounts(async ({ bobId }) => {
    const { version } = await getCredentials();
    // Signed in eleven hours ago, without staying signed in: an hour left, and reissuing it doesn't add any.
    const here = `fd_session=${createSession("owner", version, "owner", { signedInAt: Date.now() - 11 * HOUR })}`;
    const laptop = cookieOf(await signIn("owner", OWNER_PASSWORD)).cookie;
    const bob = cookieOf(await signIn("bob", USER_PASSWORD)).cookie;

    for (const currentPassword of [undefined, "not-the-password"]) {
      assert.equal((await post(here, { action: "signOutOthers", currentPassword })).status, 401);
    }
    assert.equal((await status(laptop)).authenticated, true);

    const response = await post(here, { action: "signOutOthers", currentPassword: OWNER_PASSWORD });
    assert.equal(response.status, 200);
    const reissued = cookieOf(response);
    assert.ok(reissued.maxAge <= 3600);
    assert.equal((await status(reissued.cookie)).authenticated, true);
    assert.equal((await status(here)).authenticated, false);
    assert.equal((await status(laptop)).authenticated, false);
    // Other accounts aren't touched.
    assert.equal((await status(bob)).authenticated, true);

    // A session that stays signed in still does after signing out the others.
    const kept = cookieOf(await post(reissued.cookie, { action: "stay", staySignedIn: true, currentPassword: OWNER_PASSWORD })).cookie;
    const after = cookieOf(await post(kept, { action: "signOutOthers", currentPassword: OWNER_PASSWORD }));
    assert.equal(payloadOf(after.cookie).s, 1);
    assert.equal((await info(after.cookie)).thisDevice.staysSignedIn, true);
    assert.equal((await findUserById(bobId))?.version, 1);
  });
});

test("each account chooses for itself", async () => {
  await withAccounts(async ({ bobId }) => {
    const bob = cookieOf(await signIn("bob", USER_PASSWORD)).cookie;
    // Bob's own password, not the owner's.
    assert.equal((await post(bob, { action: "stay", staySignedIn: true, currentPassword: OWNER_PASSWORD })).status, 401);
    const kept = cookieOf(await post(bob, { action: "stay", staySignedIn: true, currentPassword: USER_PASSWORD }));
    assert.ok(kept.maxAge > (STAY_SIGNED_IN_DAYS * DAY) / 1000 - 5);
    assert.equal((await findUserById(bobId))?.staySignedIn, true);
    assert.equal((await getCredentials()).staySignedIn, undefined);
    assert.ok(cookieOf(await signIn("owner", OWNER_PASSWORD)).maxAge <= 12 * 3600);
    assert.ok(cookieOf(await signIn("bob", USER_PASSWORD)).maxAge > (STAY_SIGNED_IN_DAYS * DAY) / 1000 - 5);

    assert.equal((await post(bob, { action: "nope", currentPassword: USER_PASSWORD })).status, 400);
    assert.equal((await post(bob, { action: "stay", staySignedIn: "yes", currentPassword: USER_PASSWORD })).status, 400);
    const signedOut = await sessionAction(new Request("http://localhost/api/auth/session", { method: "POST", headers: json, body: JSON.stringify({ action: "signOutOthers", currentPassword: OWNER_PASSWORD }) }));
    assert.equal(signedOut.status, 401);
    const unverified = await sessionAction(new Request("http://localhost/api/auth/session", { method: "POST", headers: { "content-type": "application/json", cookie: kept.cookie }, body: JSON.stringify({ action: "signOutOthers", currentPassword: USER_PASSWORD }) }));
    assert.equal(unverified.status, 403);
  });
});

test("with two-factor sign-in on, turning on staying signed in also needs a code", async () => {
  await withAccounts(async ({ bobId }) => {
    const secret = generateSecret();
    await updateUserAccount(bobId, async (user) => ({ next: { ...user, twoFactor: { secret, recoveryCodes: [], lastStep: 0, enabledAt: new Date().toISOString() } }, result: undefined }));
    const bob = `fd_session=${createSession("bob", 1, bobId)}`;
    assert.equal((await info(bob)).twoFactor, true);

    const missing = await post(bob, { action: "stay", staySignedIn: true, currentPassword: USER_PASSWORD });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { code: string }).code, "CODE_REQUIRED");
    assert.equal((await post(bob, { action: "stay", staySignedIn: true, currentPassword: USER_PASSWORD, code: "000000" })).status, 401);
    assert.equal((await findUserById(bobId))?.staySignedIn, undefined);

    const turnedOn = await post(bob, { action: "stay", staySignedIn: true, currentPassword: USER_PASSWORD, code: totpAt(secret, currentStep()) });
    assert.equal(turnedOn.status, 200);
    assert.equal((await findUserById(bobId))?.staySignedIn, true);
    // Signing out other devices needs only the password.
    assert.equal((await post(cookieOf(turnedOn).cookie, { action: "signOutOthers", currentPassword: USER_PASSWORD })).status, 200);
  });
});

test("a session signed out while its request was under way can't come back with a new one", async () => {
  await withAccounts(async ({ bobId }) => {
    const cookie = `fd_session=${createSession("bob", 1, bobId)}`;
    const session = await getSession(new Request("http://localhost/", { headers: { cookie } }));
    assert.ok(session);
    // The password changes (signing every session out) before the request's change is made.
    await changeOwnPassword(bobId, "another-long-password-here");
    await assert.rejects(signOutEverywhere(session), (error: Error & { status?: number }) => error.status === 401);
    assert.equal((await findUserById(bobId))?.version, 2);
  });
});
