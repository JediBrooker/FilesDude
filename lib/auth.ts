import crypto from "node:crypto";
import { config, configurationIssues, isValidPasswordHash } from "./config";
import { getCredentials, updateCredentials } from "./credentials";
import { AppError } from "./http";
import { addressGroup } from "./address-group";
import { connectionPeer, normalizeAddress } from "./peer";
import type { Role } from "./scope";
import { findUserById, updateUserAccount } from "./users";

export interface Session {
  username: string;
  credentialsVersion: number;
  /** "owner" for the installer's login, otherwise the account id. */
  accountKey: string;
  role: Role;
  root: string;
  /** This device stays signed in: the account stays signed in, and did when this session began. */
  staySignedIn: boolean;
  /** When this device signed in (ms). Renewing or reissuing the session keeps it. */
  signedInAt: number;
  /** When the session ends (ms), unless it's renewed first. */
  expiresAt: number;
}

// An account that stays signed in keeps each device signed in while it's used at least every
// STAY_SIGNED_IN_DAYS days: its sessions are renewed (at most daily, when the page checks in)
// instead of ending FILEDUDE_SESSION_HOURS after sign-in.
export const STAY_SIGNED_IN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const sessionMs = () => config.sessionHours * 60 * 60 * 1000;
const keptMs = () => Math.max(STAY_SIGNED_IN_DAYS * DAY_MS, sessionMs());

const COOKIE = "fd_session";
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_RATE_LIMIT_KEYS = 10_000;
let lastLoginAttemptSweep = 0;

function scryptPassword(password: string, salt: Buffer, length: number, options: crypto.ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

// Sessions are signed with the secret and, once a credentials reset has happened, its generation
// (FILEDUDE_SESSION_EPOCH): a reset ends every session without changing the secret, which share
// links and saved server credentials also depend on.
function signature(payload: string) {
  const key = config.sessionEpoch ? `${config.sessionSecret}\u0000sessions\u0000${config.sessionEpoch}` : config.sessionSecret;
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function assertConfigured() {
  const issues = configurationIssues();
  if (issues.length) {
    throw new AppError(issues.join(". "), 503, "NOT_CONFIGURED");
  }
}

// Each password check runs scrypt on Node's small shared thread pool (which file work uses too), so
// only a few run at once: a flood of sign-ins is turned away instead of slowing everything down.
const MAX_PASSWORD_CHECKS = 4;
let passwordChecks = 0;

export async function verifyPassword(password: string, encoded = config.passwordHash) {
  if (passwordChecks >= MAX_PASSWORD_CHECKS) throw new AppError("Too many sign-ins at once; try again in a moment", 429, "RATE_LIMITED");
  passwordChecks += 1;
  try {
    return await checkPassword(password, encoded);
  } finally {
    passwordChecks -= 1;
  }
}

async function checkPassword(password: string, encoded: string) {
  if (!isValidPasswordHash(encoded)) return false;
  const [algorithm, nRaw, rRaw, pRaw, salt, expectedRaw] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedRaw) return false;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(expectedRaw, "base64url");
  const actual = await scryptPassword(password, Buffer.from(salt, "base64url"), expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A session token. One made to stay signed in lasts STAY_SIGNED_IN_DAYS and is renewed as it's
 * used; any other ends FILEDUDE_SESSION_HOURS after `signedInAt`, which a reissued session keeps,
 * so reissuing one never makes it last longer.
 */
export function createSession(username: string, credentialsVersion: number, accountKey = "owner", { staySignedIn = false, signedInAt = Date.now() }: { staySignedIn?: boolean; signedInAt?: number } = {}) {
  assertConfigured();
  const payload = base64url(
    JSON.stringify({
      u: username,
      k: accountKey,
      v: credentialsVersion,
      iat: signedInAt,
      exp: staySignedIn ? Date.now() + keptMs() : signedInAt + sessionMs(),
      ...(staySignedIn ? { s: 1 } : {}),
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  );
  return `${payload}.${signature(payload)}`;
}

/** A new token for this device's session (after its account changed), keeping when it signed in and whether it stays signed in. */
export function reissueSession(session: Session, credentialsVersion = session.credentialsVersion) {
  return createSession(session.username, credentialsVersion, session.accountKey, { staySignedIn: session.staySignedIn, signedInAt: session.signedInAt });
}

/**
 * A renewed cookie for a session that stays signed in, once a day has passed since it was last
 * made, so the device stays signed in while it's used; null when none is due.
 */
export function renewedSessionCookie(session: Session, request: Request) {
  if (!session.staySignedIn || session.expiresAt - Date.now() > keptMs() - DAY_MS) return null;
  return sessionCookie(reissueSession(session), request);
}

type SessionSettings = { username: string; version: number; staySignedIn?: boolean; updatedAt?: string };

/**
 * Changes how a signed-in account's sessions last, one change at a time: whether it stays signed
 * in, and whether to sign it out everywhere (by bumping its version). Only for a session that is
 * still current when the change is made, so one signed out meanwhile (by a password change, say)
 * can't come back with a new session. Returns the account's username and version afterwards, and
 * whether staying signed in changed.
 */
function changeSessions(session: Session, decide: (stored: SessionSettings) => { staySignedIn: boolean; signOut: boolean }) {
  const apply = <S extends SessionSettings>(stored: S) => {
    if (stored.version !== session.credentialsVersion || stored.username !== session.username) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
    const { staySignedIn, signOut } = decide(stored);
    const changed = staySignedIn !== (stored.staySignedIn === true);
    if (!changed && !signOut) return { next: null, result: { username: stored.username, version: stored.version, changed } };
    const next: S = { ...stored, version: stored.version + (signOut ? 1 : 0), updatedAt: new Date().toISOString() };
    if (staySignedIn) next.staySignedIn = true;
    else delete next.staySignedIn;
    return { next, result: { username: next.username, version: next.version, changed } };
  };
  return session.accountKey === "owner" ? updateCredentials(async (credentials) => apply(credentials)) : updateUserAccount(session.accountKey, async (user) => apply(user));
}

/**
 * Turns staying signed in on or off for a session's account. Turning it off signs the account out
 * everywhere, as its devices may have been signed in for weeks.
 */
export function setStaySignedIn(session: Session, staySignedIn: boolean) {
  return changeSessions(session, (stored) => ({ staySignedIn, signOut: !staySignedIn && stored.staySignedIn === true }));
}

/** Signs a session's account out everywhere (the caller gives its own device a new session). */
export function signOutEverywhere(session: Session) {
  return changeSessions(session, (stored) => ({ staySignedIn: stored.staySignedIn === true, signOut: true }));
}

/** Whether the request came through one of the configured proxies, judged by its real connection. */
export function viaTrustedProxy(request: Request) {
  const peer = connectionPeer(request);
  return Boolean(peer) && config.trustedProxies.includes(peer);
}

/** Whether the browser reached FilesDude over HTTPS (directly, or through a trusted proxy). */
export function reachedOverHttps(request: Request) {
  if (new URL(request.url).protocol === "https:") return true;
  return (viaTrustedProxy(request) || config.trustProxy) && request.headers.get("x-forwarded-proto") === "https";
}

function readPayload(payload: string) {
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

export function sessionCookie(value: string, request: Request) {
  const secure = reachedOverHttps(request);
  // The cookie lasts as long as the session it carries.
  const expires = readPayload(value.split(".")[0]).exp as number;
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}

export function clearSessionCookie(request: Request) {
  const secure = reachedOverHttps(request);
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0;${secure ? " Secure;" : ""}`;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : "";
}

export async function getSession(request: Request): Promise<Session | null> {
  if (configurationIssues().length) return null;
  const token = cookieValue(request, COOKIE);
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;

  const expectedSignature = signature(payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const value = readPayload(payload);
    const now = Date.now();
    if (typeof value.exp !== "number" || value.exp < now || typeof value.u !== "string") return null;
    // Sessions from before staying signed in carry no sign-in time; they lasted FILEDUDE_SESSION_HOURS.
    const signedInAt = typeof value.iat === "number" ? value.iat : value.exp - sessionMs();
    let account: Omit<Session, "staySignedIn" | "signedInAt" | "expiresAt">;
    let accountStays: boolean;
    // Sessions from before accounts existed carry no account key and belong to the owner.
    if (value.k === undefined || value.k === "owner") {
      const credentials = await getCredentials();
      if (value.u !== credentials.username || value.v !== credentials.version) return null;
      account = { username: value.u, credentialsVersion: value.v, accountKey: "owner", role: "owner", root: "" };
      accountStays = credentials.staySignedIn === true;
    } else {
      if (typeof value.k !== "string") return null;
      const user = await findUserById(value.k);
      if (!user || user.username !== value.u || user.version !== value.v) return null;
      account = { username: user.username, credentialsVersion: user.version, accountKey: user.id, role: user.role, root: user.root };
      accountStays = user.staySignedIn === true;
    }
    // Any session not made to stay signed in, or whose account no longer does, ends
    // FILEDUDE_SESSION_HOURS after sign-in, however long its token says.
    const staySignedIn = value.s === 1 && accountStays;
    if (!staySignedIn && signedInAt + sessionMs() <= now) return null;
    return { ...account, staySignedIn, signedInAt, expiresAt: value.exp };
  } catch {
    return null;
  }
}

export async function requireSession(request: Request) {
  assertConfigured();
  const session = await getSession(request);
  if (!session) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
  return session;
}

/**
 * The address a request comes from, for sign-in limits and the audit log. A connection from a
 * trusted proxy (FILEDUDE_TRUSTED_PROXIES) is believed about the client behind it: Cloudflare's
 * CF-Connecting-IP, or else the nearest address the proxies added to X-Forwarded-For. Any other
 * connection is its own address, whatever headers it sends, so nobody can claim to be someone else.
 */
export function clientAddress(request: Request) {
  const peer = connectionPeer(request);
  const trusted = (address: string) => config.trustedProxies.includes(address);
  const forwardedChain = () => (request.headers.get("x-forwarded-for") ?? "").split(",").map(normalizeAddress).filter(Boolean);
  if (peer && trusted(peer)) {
    const cloudflare = normalizeAddress(request.headers.get("cf-connecting-ip"));
    if (cloudflare) return cloudflare;
    const chain = forwardedChain();
    for (let index = chain.length - 1; index >= 0; index -= 1) if (!trusted(chain[index])) return chain[index];
    return peer;
  }
  if (peer && !config.trustProxy) return peer;
  // FILEDUDE_TRUST_PROXY: every connection is a proxy; the address it added is the last one.
  if (config.trustProxy) return forwardedChain().at(-1) || (peer ? peer : "proxy-unknown");
  return "direct-client";
}

function sweepLoginAttempts(now: number) {
  if (now - lastLoginAttemptSweep < 60_000 && loginAttempts.size < MAX_LOGIN_RATE_LIMIT_KEYS && usernameAttempts.size < MAX_LOGIN_RATE_LIMIT_KEYS) return;
  for (const table of [loginAttempts, usernameAttempts]) {
    for (const [key, attempt] of table) {
      if (attempt.resetAt <= now) table.delete(key);
    }
  }
  lastLoginAttemptSweep = now;
}

// Sign-in tries are counted per address (an IPv6 address by its /64, which one person can use all of)
// and per username (so a password can't be guessed from many addresses). A full table drops its
// oldest entries rather than turning everyone away. A successful sign-in only gives back its own
// try: it never clears what failed before it from the same address, so signing in to one account
// can't make room for guesses at another.
const ADDRESS_LIMIT = 5;
const USERNAME_LIMIT = 20;
const usernameAttempts = new Map<string, { count: number; resetAt: number }>();
const addressKey = (key: string) => `address:${addressGroup(key)}`;
const usernameKey = (username: string) => username.trim().toLowerCase().slice(0, 64);

function countAttempt(table: Map<string, { count: number; resetAt: number }>, key: string, limit: number) {
  const now = Date.now();
  sweepLoginAttempts(now);
  const attempt = table.get(key);
  if (attempt && attempt.resetAt > now) {
    if (attempt.count >= limit) throw new AppError("Too many login attempts. Try again later.", 429, "RATE_LIMITED");
    attempt.count += 1;
    return;
  }
  while (table.size >= MAX_LOGIN_RATE_LIMIT_KEYS) table.delete(table.keys().next().value!);
  table.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
}

function giveBack(table: Map<string, { count: number; resetAt: number }>, key: string) {
  const attempt = table.get(key);
  if (attempt && attempt.count > 0) attempt.count -= 1;
}

/**
 * Counts a sign-in attempt from an address as it starts, before anything is awaited, so requests sent
 * in parallel can't all get past the limit. A successful sign-in (or a right password that still needs
 * a two-factor code) gives its try back with refundLoginAttempt.
 */
export function checkLoginRateLimit(key: string) {
  countAttempt(loginAttempts, addressKey(key), ADDRESS_LIMIT);
}

/** Refuses an address that's locked out, without counting a try (asking for a passkey challenge). */
export function assertLoginAllowed(key: string) {
  const attempt = loginAttempts.get(addressKey(key));
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= ADDRESS_LIMIT) throw new AppError("Too many login attempts. Try again later.", 429, "RATE_LIMITED");
}

export function refundLoginAttempt(key: string) {
  giveBack(loginAttempts, addressKey(key));
}

/** Counts a password try at a username (known or not), as it starts. */
export function checkUsernameRateLimit(username: string) {
  countAttempt(usernameAttempts, usernameKey(username), USERNAME_LIMIT);
}

export function refundUsernameAttempt(username: string) {
  giveBack(usernameAttempts, usernameKey(username));
}

/** Forgets an address's tries (tests, and nothing else: sign-ins only give back their own). */
export function clearLoginFailures(key: string) {
  loginAttempts.delete(addressKey(key));
  loginAttempts.delete(key);
}

// Checks of the current password from a signed-in session (before adding a passkey or changing
// two-factor sign-in, say) are limited per device, so a session left open can't be used to guess it.
// A device is its account and when it signed in, which renewing a session keeps: wrong guesses from
// a session someone else holds lock only that session, never its owner's other devices, which they
// need to sign it out. A try is counted as it starts; the right password clears the count.
const CURRENT_PASSWORD_LIMIT = 10;
const MAX_CURRENT_PASSWORD_KEYS = 10_000;
const currentPasswordChecks = new Map<string, { count: number; resetAt: number }>();

export async function verifyCurrentPassword(session: Pick<Session, "accountKey" | "signedInAt">, password: unknown, encoded: string) {
  const key = `${session.accountKey}\u0000${session.signedInAt}`;
  const now = Date.now();
  if (currentPasswordChecks.size >= MAX_CURRENT_PASSWORD_KEYS) {
    for (const [checked, attempt] of currentPasswordChecks) if (attempt.resetAt <= now) currentPasswordChecks.delete(checked);
  }
  let attempt = currentPasswordChecks.get(key);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + 15 * 60 * 1000 };
    currentPasswordChecks.set(key, attempt);
  }
  if (attempt.count >= CURRENT_PASSWORD_LIMIT) throw new AppError("Too many wrong passwords. Try again in 15 minutes.", 429, "PASSWORD_LOCKED");
  attempt.count += 1;
  const valid = typeof password === "string" && password.length <= 512 && (await verifyPassword(password, encoded));
  if (valid) currentPasswordChecks.delete(key);
  return valid;
}
