import crypto from "node:crypto";
import { config, configurationIssues } from "./config";
import { getCredentials } from "./credentials";
import { AppError } from "./http";

const COOKIE = "fd_session";
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

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

export function createSession(username: string, credentialsVersion: number) {
  assertConfigured();
  const payload = base64url(
    JSON.stringify({
      u: username,
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

export async function getSession(request: Request): Promise<{ username: string; credentialsVersion: number } | null> {
  if (configurationIssues().length) return null;
  const token = cookieValue(request, COOKIE);
  const [payload, suppliedSignature] = token.split(".");
  if (!payload || !suppliedSignature) return null;

  const expectedSignature = signature(payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const credentials = await getCredentials();
    if (value.u !== credentials.username || value.v !== credentials.version || typeof value.exp !== "number" || value.exp < Date.now()) return null;
    return { username: value.u, credentialsVersion: value.v };
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
    return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "proxy-unknown";
  }
  return "direct-client";
}

export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (attempt.count >= 5) {
    throw new AppError("Too many login attempts. Try again later.", 429, "RATE_LIMITED");
  }
}

export function recordLoginFailure(key: string) {
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  attempt.count += 1;
  loginAttempts.set(key, attempt);
}

export function clearLoginFailures(key: string) {
  loginAttempts.delete(key);
}
