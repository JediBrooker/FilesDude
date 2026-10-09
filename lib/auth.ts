import crypto from "node:crypto";
import net from "node:net";
import { config, configurationIssues, isValidPasswordHash } from "./config";
import { getCredentials } from "./credentials";
import { AppError } from "./http";
import type { Role } from "./scope";
import { findUserById } from "./users";

export interface Session {
  username: string;
  credentialsVersion: number;
  /** "owner" for the installer's login, otherwise the account id. */
  accountKey: string;
  role: Role;
  root: string;
}

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

function signature(payload: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function assertConfigured() {
  const issues = configurationIssues();
  if (issues.length) {
    throw new AppError(issues.join(". "), 503, "NOT_CONFIGURED");
  }
}

export async function verifyPassword(password: string, encoded = config.passwordHash) {
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

export function createSession(username: string, credentialsVersion: number, accountKey = "owner") {
  assertConfigured();
  const payload = base64url(
    JSON.stringify({
      u: username,
      k: accountKey,
      v: credentialsVersion,
      exp: Date.now() + config.sessionHours * 60 * 60 * 1000,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  );
  return `${payload}.${signature(payload)}`;
}

export function sessionCookie(value: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" || (config.trustProxy && request.headers.get("x-forwarded-proto") === "https");
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600};${secure ? " Secure;" : ""}`;
}

export function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" || (config.trustProxy && request.headers.get("x-forwarded-proto") === "https");
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
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof value.exp !== "number" || value.exp < Date.now() || typeof value.u !== "string") return null;
    // Sessions from before accounts existed carry no account key and belong to the owner.
    if (value.k === undefined || value.k === "owner") {
      const credentials = await getCredentials();
      if (value.u !== credentials.username || value.v !== credentials.version) return null;
      return { username: value.u, credentialsVersion: value.v, accountKey: "owner", role: "owner", root: "" };
    }
    if (typeof value.k !== "string") return null;
    const user = await findUserById(value.k);
    if (!user || user.username !== value.u || user.version !== value.v) return null;
    return { username: user.username, credentialsVersion: user.version, accountKey: user.id, role: user.role, root: user.root };
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

export function clientAddress(request: Request) {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    return net.isIP(forwarded) ? forwarded : "proxy-unknown";
  }
  return "direct-client";
}

function sweepLoginAttempts(now: number) {
  if (now - lastLoginAttemptSweep < 60_000 && loginAttempts.size < MAX_LOGIN_RATE_LIMIT_KEYS) return;
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(key);
  }
  lastLoginAttemptSweep = now;
}

/**
 * Counts a sign-in attempt as it starts, before anything is awaited, so requests sent in parallel
 * can't all get past the limit. A successful sign-in clears the count; a right password that still
 * needs a two-factor code gives its attempt back with refundLoginAttempt.
 */
export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  sweepLoginAttempts(now);
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    if (loginAttempts.size >= MAX_LOGIN_RATE_LIMIT_KEYS) {
      throw new AppError("Too many login attempts. Try again later.", 429, "RATE_LIMITED");
    }
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (attempt.count >= 5) {
    throw new AppError("Too many login attempts. Try again later.", 429, "RATE_LIMITED");
  }
  attempt.count += 1;
}

export function refundLoginAttempt(key: string) {
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.count > 0) attempt.count -= 1;
}

export function clearLoginFailures(key: string) {
  loginAttempts.delete(key);
}
