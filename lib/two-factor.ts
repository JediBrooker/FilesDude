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

export type Account = { key: string; username: string; passwordHash: string; version: number; twoFactor?: StoredTwoFactor };

export async function findAccount(accountKey: string): Promise<Account | null> {
  if (accountKey === "owner") {
    const credentials = await getCredentials();
    return { key: "owner", username: credentials.username, passwordHash: credentials.passwordHash, version: credentials.version, twoFactor: credentials.twoFactor };
  }
  const user = await findUserById(accountKey);
  return user ? { key: user.id, username: user.username, passwordHash: user.passwordHash, version: user.version, twoFactor: user.twoFactor } : null;
}

type TwoFactorChange<T> = { twoFactor?: StoredTwoFactor | null; bumpVersion?: boolean; result: T };

/**
 * Changes an account's two-factor settings one change at a time, so a code can't be used twice by
 * requests racing each other. `twoFactor` undefined leaves them unchanged and null removes them;
 * `bumpVersion` signs the account out everywhere. Returns the result and the account's version.
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
      const outcome = await change({ key: "owner", username: credentials.username, passwordHash: credentials.passwordHash, version: credentials.version, twoFactor: credentials.twoFactor });
      const next = apply(credentials, outcome);
      return { next, result: { result: outcome.result, version: (next ?? credentials).version, username: credentials.username } };
    });
  }
  return updateUserAccount(accountKey, async (user) => {
    const outcome = await change({ key: user.id, username: user.username, passwordHash: user.passwordHash, version: user.version, twoFactor: user.twoFactor });
    const next = apply(user, outcome);
    return { next, result: { result: outcome.result, version: (next ?? user).version, username: user.username } };
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

// --- Sign-in ---

const challengeAttempts = new Map<string, { count: number; expiresAt: number }>();

export function createChallenge(account: Account) {
  const now = Date.now();
  for (const [nonce, attempt] of challengeAttempts) if (attempt.expiresAt <= now) challengeAttempts.delete(nonce);
  return signToken("challenge", { k: account.key, v: account.version, n: crypto.randomBytes(16).toString("hex"), exp: now + CHALLENGE_MS });
}

/**
 * Completes a sign-in challenge with a code. Each challenge allows a few attempts. Returns the
 * account's key, username, and version for the session, and how the code was given.
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
  const outcome = await changeTwoFactor(payload.k, (account) => {
    if (account.version !== payload.v || !account.twoFactor) throw new AppError("Your sign-in has expired. Enter your password again.", 401, "CHALLENGE_EXPIRED");
    const used = consumeCode(account.twoFactor, code);
    if (!used) throw wrongCode();
    return { twoFactor: used.twoFactor, result: { method: used.method, recoveryCodesLeft: used.twoFactor.recoveryCodes.length } };
  });
  challengeAttempts.delete(nonce);
  return { accountKey: payload.k, username: outcome.username, version: outcome.version, ...outcome.result };
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
  return changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is already off", 409, "TWO_FACTOR_DISABLED");
    if (!consumeCode(account.twoFactor, code)) throw wrongCode();
    return { twoFactor: null, bumpVersion: true, result: undefined };
  });
}

/** Replaces the recovery codes, after a code proves the device is at hand. */
export async function regenerateRecoveryCodes(accountKey: string, code: unknown) {
  const recoveryCodes = newRecoveryCodes();
  return changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is off", 409, "TWO_FACTOR_DISABLED");
    const used = consumeCode(account.twoFactor, code);
    if (!used) throw wrongCode();
    return { twoFactor: { ...used.twoFactor, recoveryCodes: recoveryCodes.map((item) => hashRecoveryCode(normalizeCode(item))) }, result: recoveryCodes };
  });
}

/** Removes an account's two-factor sign-in (the owner's reset for a lost device) and signs it out. */
export async function resetTwoFactor(accountKey: string) {
  return changeTwoFactor(accountKey, (account) => {
    if (!account.twoFactor) throw new AppError("Two-factor sign-in is already off for that account", 409, "TWO_FACTOR_DISABLED");
    return { twoFactor: null, bumpVersion: true, result: undefined };
  });
}
