import crypto from "node:crypto";
import QRCode from "qrcode";
import { config } from "./config";
import { getCredentials, updateCredentials, type StoredTwoFactor } from "./credentials";
import { AppError } from "./http";
import { generateSecret, otpauthUri, verifyTotp } from "./totp";
import { findUserById, updateUserAccount } from "./users";

// Two-factor sign-in with an authenticator app. Signing in with a password alone yields a short-lived
// challenge (not a session) for accounts that have it on; the challenge plus a code from the app (or
// a recovery code) then yields the session. Setup, challenges, and codes are all bound to the
// account's credentials version, so a password change or reset invalidates any in flight.
const CHALLENGE_MS = 5 * 60_000;
const SETUP_MS = 10 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export type Account = { key: string; username: string; passwordHash: string; version: number; twoFactor?: StoredTwoFactor; staySignedIn: boolean };

export async function findAccount(accountKey: string): Promise<Account | null> {
  if (accountKey === "owner") {
    const credentials = await getCredentials();
    return { key: "owner", username: credentials.username, passwordHash: credentials.passwordHash, version: credentials.version, twoFactor: credentials.twoFactor, staySignedIn: credentials.staySignedIn === true };
  }
  const user = await findUserById(accountKey);
  return user ? { key: user.id, username: user.username, passwordHash: user.passwordHash, version: user.version, twoFactor: user.twoFactor, staySignedIn: user.staySignedIn === true } : null;
}

type TwoFactorChange<T> = { twoFactor?: StoredTwoFactor | null; bumpVersion?: boolean; result: T };

/**
 * Changes an account's two-factor settings one change at a time, so a code can't be used twice by
 * requests racing each other. `twoFactor` undefined leaves them unchanged and null removes them;
 * `bumpVersion` signs the account out everywhere. Returns the result and the account's version and
 * whether it stays signed in, as they now are.
 */
async function changeTwoFactor<T>(accountKey: string, change: (account: Account) => TwoFactorChange<T> | Promise<TwoFactorChange<T>>) {
  const apply = <S extends { version: number; twoFactor?: StoredTwoFactor; updatedAt?: string }>(stored: S, outcome: TwoFactorChange<T>): S | null => {
    if (outcome.twoFactor === undefined && !outcome.bumpVersion) return null;
    const next = { ...stored, version: stored.version + (outcome.bumpVersion ? 1 : 0), updatedAt: new Date().toISOString() };
    if (outcome.twoFactor === null) delete next.twoFactor;
    else if (outcome.twoFactor) next.twoFactor = outcome.twoFactor;
    return next;
  };
  if (accountKey === "owner") {
    return updateCredentials(async (credentials) => {
      const outcome = await change({ key: "owner", username: credentials.username, passwordHash: credentials.passwordHash, version: credentials.version, twoFactor: credentials.twoFactor, staySignedIn: credentials.staySignedIn === true });
      const next = apply(credentials, outcome);
      return { next, result: { result: outcome.result, version: (next ?? credentials).version, username: credentials.username, staySignedIn: credentials.staySignedIn === true } };
    });
  }
  return updateUserAccount(accountKey, async (user) => {
    const outcome = await change({ key: user.id, username: user.username, passwordHash: user.passwordHash, version: user.version, twoFactor: user.twoFactor, staySignedIn: user.staySignedIn === true });
    const next = apply(user, outcome);
    return { next, result: { result: outcome.result, version: (next ?? user).version, username: user.username, staySignedIn: user.staySignedIn === true } };
  });
}

// Signed tokens: a key separate from sessions' and share links', per purpose.
function tokenKey(purpose: string) {
  return Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), `filesdude-two-factor-${purpose}-v1`, 32));
}

function signToken(purpose: string, payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", tokenKey(purpose)).update(body).digest("base64url")}`;
}

function readToken(purpose: string, token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra !== undefined) return null;
  const expected = Buffer.from(crypto.createHmac("sha256", tokenKey(purpose)).update(body).digest("base64url"));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.exp === "number" && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

const hashRecoveryCode = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const normalizeCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, "");

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const characters = Array.from(crypto.randomBytes(10), (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
    return `${characters.slice(0, 5)}-${characters.slice(5)}`;
  });
}

/**
 * Checks a code from the authenticator app (6 digits) or a recovery code, and consumes it: the app
 * code's time step can't be used again, and a recovery code is removed. Returns the updated settings,
 * or null if the code is wrong.
 */
function consumeCode(twoFactor: StoredTwoFactor, rawCode: unknown): { twoFactor: StoredTwoFactor; method: "app" | "recovery" } | null {
  if (typeof rawCode !== "string" || rawCode.length > 64) return null;
  const code = normalizeCode(rawCode);
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(twoFactor.secret, code, twoFactor.lastStep);
    return step === null ? null : { twoFactor: { ...twoFactor, lastStep: step }, method: "app" };
  }
  const hashed = Buffer.from(hashRecoveryCode(code));
  const index = twoFactor.recoveryCodes.findIndex((stored) => stored.length === hashed.length && crypto.timingSafeEqual(Buffer.from(stored), hashed));
  if (index < 0) return null;
  return { twoFactor: { ...twoFactor, recoveryCodes: twoFactor.recoveryCodes.filter((_, position) => position !== index) }, method: "recovery" };
}

const wrongCode = () => new AppError("That code isn't right. Use the current code from your authenticator app, or a recovery code.", 401, "INVALID_TWO_FACTOR_CODE");

// Each account may get a code wrong a few times in 15 minutes, wherever the code is entered (signing
// in, turning two-factor sign-in off, or replacing recovery codes). A try is counted when it starts,
// so parallel requests can't exceed the limit, and a right code clears the count.
const CODE_ATTEMPT_LIMIT = 5;
const CODE_LOCK_MS = 15 * 60_000;
const codeAttempts = new Map<string, { count: number; resetAt: number }>();

function reserveCodeAttempt(accountKey: string) {
  const now = Date.now();
  const attempt = codeAttempts.get(accountKey);
  if (!attempt || attempt.resetAt <= now) {
    codeAttempts.set(accountKey, { count: 1, resetAt: now + CODE_LOCK_MS });
    return;
  }
  if (attempt.count >= CODE_ATTEMPT_LIMIT) throw new AppError("Too many wrong codes for this account. Try again in 15 minutes.", 429, "TWO_FACTOR_LOCKED");
  attempt.count += 1;
}

/** Runs a code check for an account within its limit on wrong codes. */
async function withCodeAttempt<T>(accountKey: string, check: () => Promise<T>) {
  reserveCodeAttempt(accountKey);
  const result = await check();
  codeAttempts.delete(accountKey);
  return result;
}

// --- Sign-in ---

const challengeAttempts = new Map<string, { count: number; expiresAt: number }>();

export function createChallenge(account: Account) {
  const now = Date.now();
  for (const [nonce, attempt] of challengeAttempts) if (attempt.expiresAt <= now) challengeAttempts.delete(nonce);
  return signToken("challenge", { k: account.key, v: account.version, n: crypto.randomBytes(16).toString("hex"), exp: now + CHALLENGE_MS });
}

/**
 * Completes a sign-in challenge with a code. Each challenge allows a few attempts. Returns the
 * account's key, username, version, and whether it stays signed in, for the session, and how the
 * code was given.
 */
export async function completeChallenge(challenge: unknown, code: unknown) {
  const payload = readToken("challenge", challenge);
  if (!payload || typeof payload.k !== "string" || typeof payload.v !== "number" || typeof payload.n !== "string") {
    throw new AppError("Your sign-in has expired. Enter your password again.", 401, "CHALLENGE_EXPIRED");
  }
  const nonce = payload.n;
  const attempt = challengeAttempts.get(nonce) ?? { count: 0, expiresAt: payload.exp as number };
  if (attempt.count >= MAX_CHALLENGE_ATTEMPTS) throw new AppError("Too many wrong codes. Enter your password again.", 401, "CHALLENGE_EXPIRED");
  attempt.count += 1;
  challengeAttempts.set(nonce, attempt);
  const outcome = await withCodeAttempt(payload.k, () => changeTwoFactor(payload.k as string, (account) => {
    if (account.version !== payload.v || !account.twoFactor) throw new AppError("Your sign-in has expired. Enter your password again.", 401, "CHALLENGE_EXPIRED");
    const used = consumeCode(account.twoFactor, code);
    if (!used) throw wrongCode();
    return { twoFactor: used.twoFactor, result: { method: used.method, recoveryCodesLeft: used.twoFactor.recoveryCodes.length } };
  }));
  challengeAttempts.delete(nonce);
  return { accountKey: payload.k, username: outcome.username, version: outcome.version, staySignedIn: outcome.staySignedIn, ...outcome.result };
}

// --- Managing it from a signed-in account ---

export async function twoFactorStatus(accountKey: string) {
  const account = await findAccount(accountKey);
  return { enabled: Boolean(account?.twoFactor), enabledAt: account?.twoFactor?.enabledAt ?? null, recoveryCodesLeft: account?.twoFactor?.recoveryCodes.length ?? 0 };
}

/** Starts setup: a new secret, its QR code, and a token that proves this server issued it. */
export async function beginSetup(account: Account) {
  if (account.twoFactor) throw new AppError("Two-factor sign-in is already on", 409, "TWO_FACTOR_ENABLED");
  const secret = generateSecret();
  const uri = otpauthUri(secret, account.username);
  const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return {
    secret,
    uri,
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    setupToken: signToken("setup", { k: account.key, v: account.version, s: secret, exp: Date.now() + SETUP_MS }),
  };
}

/** Turns two-factor sign-in on once a code from the new secret checks out; returns the recovery codes. */
export async function finishSetup(accountKey: string, setupToken: unknown, code: unknown) {
  const payload = readToken("setup", setupToken);
  if (!payload || payload.k !== accountKey || typeof payload.v !== "number" || typeof payload.s !== "string") {
    throw new AppError("Setup has expired. Start again.", 400, "SETUP_EXPIRED");
  }
  const secret = payload.s;
  const recoveryCodes = newRecoveryCodes();
  return changeTwoFactor(accountKey, (account) => {
    if (account.version !== payload.v) throw new AppError("Setup has expired. Start again.", 400, "SETUP_EXPIRED");
    if (account.twoFactor) throw new AppError("Two-factor sign-in is already on", 409, "TWO_FACTOR_ENABLED");
    const step = typeof code === "string" ? verifyTotp(secret, normalizeCode(code)) : null;
    if (step === null) throw new AppError("That code isn't right. Check your authenticator app's clock and try the current code.", 400, "INVALID_TWO_FACTOR_CODE");
    const twoFactor: StoredTwoFactor = { secret, recoveryCodes: recoveryCodes.map((item) => hashRecoveryCode(normalizeCode(item))), lastStep: step, enabledAt: new Date().toISOString() };
    return { twoFactor, bumpVersion: true, result: recoveryCodes };
  });
}

/** Turns two-factor sign-in off, after a code (or recovery code) proves the device is at hand. */
export async function disableTwoFactor(accountKey: string, code: unknown) {
  return withCodeAttempt(accountKey, () => changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is already off", 409, "TWO_FACTOR_DISABLED");
    if (!consumeCode(account.twoFactor, code)) throw wrongCode();
    return { twoFactor: null, bumpVersion: true, result: undefined };
  }));
}

/** Replaces the recovery codes, after a code proves the device is at hand, and signs out other sessions. */
export async function regenerateRecoveryCodes(accountKey: string, code: unknown) {
  const recoveryCodes = newRecoveryCodes();
  return withCodeAttempt(accountKey, () => changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is off", 409, "TWO_FACTOR_DISABLED");
    const used = consumeCode(account.twoFactor, code);
    if (!used) throw wrongCode();
    return { twoFactor: { ...used.twoFactor, recoveryCodes: recoveryCodes.map((item) => hashRecoveryCode(normalizeCode(item))) }, bumpVersion: true, result: recoveryCodes };
  }));
}

/**
 * Checks and consumes a code for an account that has two-factor sign-in, within its limit on wrong
 * codes, without changing anything else. Used before adding a passkey, which signs in without a code.
 */
export async function confirmWithCode(accountKey: string, code: unknown) {
  await withCodeAttempt(accountKey, () => changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) return { result: undefined };
    const used = consumeCode(account.twoFactor, code);
    if (!used) throw wrongCode();
    return { twoFactor: used.twoFactor, result: undefined };
  }));
}

/**
 * Removes another account's two-factor sign-in (the owner's reset for a lost device) and signs it
 * out. The owner's own can only be turned off with a code, or cleared on the server.
 */
export async function resetTwoFactor(accountKey: string) {
  if (accountKey === "owner") throw new AppError("The owner turns off their own two-factor sign-in from Preferences", 400, "INVALID_REQUEST");
  return changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is already off for that account", 409, "TWO_FACTOR_DISABLED");
    return { twoFactor: null, bumpVersion: true, result: undefined };
  });
}
