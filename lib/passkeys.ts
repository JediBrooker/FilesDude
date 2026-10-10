import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { config } from "./config";
import { AppError } from "./http";
import { findAccount, type Account } from "./two-factor";

// Passkeys: sign-in with a device's fingerprint, face, or PIN instead of a password. Each one belongs
// to an account and to the address it was added on (its relying party), and is discoverable, so the
// sign-in page needs no username. Only public keys are stored; the private key never leaves the device.
const CHALLENGE_MS = 5 * 60_000;
const MAX_PASSKEYS_PER_ACCOUNT = 20;
const MAX_NAME_LENGTH = 64;

export type StoredPasskey = {
  id: string;
  account: string;
  userHandle: string;
  publicKey: string;
  counter: number;
  transports?: WebAuthnCredential["transports"];
  name: string;
  rpId: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type PasskeySummary = Pick<StoredPasskey, "id" | "name" | "rpId" | "backedUp" | "createdAt" | "lastUsedAt">;

function storePath() {
  return path.join(config.stateDir, "passkeys.json");
}

async function readStore(): Promise<StoredPasskey[]> {
  const text = await fs.readFile(storePath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? (parsed as StoredPasskey[]) : [];
}

let queue: Promise<unknown> = Promise.resolve();

// Changes are made one at a time and written atomically, readable only by this service.
function mutate<T>(change: (passkeys: StoredPasskey[]) => Promise<{ next: StoredPasskey[] | null; result: T }> | { next: StoredPasskey[] | null; result: T }) {
  const run = queue.then(async () => {
    const { next, result } = await change(await readStore());
    if (next) {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${storePath()}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, storePath());
    }
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

const summary = ({ id, name, rpId, backedUp, createdAt, lastUsedAt }: StoredPasskey): PasskeySummary => ({ id, name, rpId, backedUp, createdAt, lastUsedAt });

// The WebAuthn user handle for an account: stable, and reveals nothing about the account.
function userHandle(accountKey: string) {
  const key = Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), "filesdude-passkey-user-v1", 32));
  return new Uint8Array(crypto.createHmac("sha256", key).update(accountKey).digest());
}

/**
 * Where the browser is: its origin and the relying party ID (the host name) that passkeys are bound
 * to. Comes from the Origin header, which assertMutationRequest has already matched to this server.
 * Passkeys need HTTPS, except on localhost.
 */
export function relyingParty(request: Request) {
  const origin = request.headers.get("origin");
  let url: URL;
  try {
    url = new URL(origin ?? "");
  } catch {
    throw new AppError("Passkeys need a browser request from this site", 400, "PASSKEY_UNAVAILABLE");
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new AppError("Passkeys only work when FilesDude is opened over HTTPS", 400, "PASSKEY_UNAVAILABLE");
  }
  return { origin: url.origin, rpId: url.hostname };
}

export type RelyingParty = ReturnType<typeof relyingParty>;

function cleanName(name: unknown) {
  const cleaned = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, MAX_NAME_LENGTH) : "";
  return cleaned || "Passkey";
}

export async function listPasskeys(accountKey: string) {
  return (await readStore()).filter((passkey) => passkey.account === accountKey).map(summary).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// --- Adding a passkey (signed in, after the password) ---

// One pending registration per account, bound to its credentials version so a password change ends it.
const pendingRegistrations = new Map<string, { challenge: string; version: number; origin: string; rpId: string; expiresAt: number }>();

export async function beginRegistration(account: Account, party: RelyingParty) {
  const existing = (await readStore()).filter((passkey) => passkey.account === account.key);
  if (existing.length >= MAX_PASSKEYS_PER_ACCOUNT) throw new AppError(`An account can have at most ${MAX_PASSKEYS_PER_ACCOUNT} passkeys`, 409, "PASSKEY_LIMIT");
  const options = await generateRegistrationOptions({
    rpName: "FilesDude",
    rpID: party.rpId,
    userName: account.username,
    userDisplayName: account.username,
    userID: userHandle(account.key),
    attestationType: "none",
    excludeCredentials: existing.filter((passkey) => passkey.rpId === party.rpId).map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: CHALLENGE_MS,
  });
  pendingRegistrations.set(account.key, { challenge: options.challenge, version: account.version, origin: party.origin, rpId: party.rpId, expiresAt: Date.now() + CHALLENGE_MS });
  return options;
}

export async function finishRegistration(account: Account, party: RelyingParty, response: unknown, name: unknown) {
  const pending = pendingRegistrations.get(account.key);
  pendingRegistrations.delete(account.key);
  if (!pending || pending.expiresAt <= Date.now() || pending.version !== account.version || pending.origin !== party.origin) {
    throw new AppError("Adding the passkey took too long. Try again.", 400, "PASSKEY_EXPIRED");
  }
  if (!response || typeof response !== "object") throw new AppError("The passkey response is missing", 400, "INVALID_REQUEST");
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new AppError("The passkey couldn't be verified. Try again.", 400, "PASSKEY_INVALID");
  }
  if (!verification.verified || !verification.registrationInfo) throw new AppError("The passkey couldn't be verified. Try again.", 400, "PASSKEY_INVALID");
  const { credential, credentialBackedUp } = verification.registrationInfo;
  const handle = Buffer.from(userHandle(account.key)).toString("base64url");
  return mutate(async (passkeys) => {
    // Checked again here, in turn with removals, so a password reset or deletion that lands while
    // the browser was busy can't be outlived by the passkey it would have removed.
    const current = await findAccount(account.key);
    if (!current || current.version !== pending.version) throw new AppError("Adding the passkey took too long. Try again.", 400, "PASSKEY_EXPIRED");
    if (passkeys.some((passkey) => passkey.id === credential.id)) throw new AppError("That passkey has already been added", 409, "PASSKEY_EXISTS");
    if (passkeys.filter((passkey) => passkey.account === account.key).length >= MAX_PASSKEYS_PER_ACCOUNT) throw new AppError(`An account can have at most ${MAX_PASSKEYS_PER_ACCOUNT} passkeys`, 409, "PASSKEY_LIMIT");
    const stored: StoredPasskey = {
      id: credential.id,
      account: account.key,
      userHandle: handle,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
      name: cleanName(name),
      rpId: pending.rpId,
      backedUp: credentialBackedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    return { next: [...passkeys, stored], result: summary(stored) };
  });
}

export async function renamePasskey(accountKey: string, id: unknown, name: unknown) {
  return mutate((passkeys) => {
    const found = passkeys.find((passkey) => passkey.id === id && passkey.account === accountKey);
    if (!found) throw new AppError("That passkey no longer exists", 404, "NOT_FOUND");
    const renamed = { ...found, name: cleanName(name) };
    return { next: passkeys.map((passkey) => (passkey === found ? renamed : passkey)), result: { previousName: found.name, passkey: summary(renamed) } };
  });
}

export async function removePasskey(accountKey: string, id: unknown) {
  return mutate((passkeys) => {
    const found = passkeys.find((passkey) => passkey.id === id && passkey.account === accountKey);
    if (!found) throw new AppError("That passkey no longer exists", 404, "NOT_FOUND");
    return { next: passkeys.filter((passkey) => passkey !== found), result: summary(found) };
  });
}

/** Removes every passkey of an account, when it is deleted or the owner resets its password. Returns how many. */
export async function removeAccountPasskeys(accountKey: string) {
  pendingRegistrations.delete(accountKey);
  return mutate((passkeys) => {
    const kept = passkeys.filter((passkey) => passkey.account !== accountKey);
    return { next: kept.length === passkeys.length ? null : kept, result: passkeys.length - kept.length };
  });
}

// --- Signing in (no session yet) ---

// Each sign-in gets its own challenge, handed to the browser in a signed token rather than kept here,
// so asking for challenges can't crowd out anyone else's. A token works once: its nonce is remembered
// when it is used, and verifying is limited per address, which keeps that list small.
const usedSignIns = new Map<string, number>();

function challengeKey() {
  return Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), "filesdude-passkey-challenge-v1", 32));
}

function signChallenge(payload: { c: string; o: string; r: string; n: string; exp: number }) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", challengeKey()).update(body).digest("base64url")}`;
}

function readChallenge(token: unknown) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra !== undefined) return null;
  const expected = Buffer.from(crypto.createHmac("sha256", challengeKey()).update(body).digest("base64url"));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const { c, o, r, n, exp } = payload;
    if (typeof c !== "string" || typeof o !== "string" || typeof r !== "string" || typeof n !== "string" || typeof exp !== "number" || exp <= Date.now()) return null;
    return { challenge: c, origin: o, rpId: r, nonce: n, expiresAt: exp };
  } catch {
    return null;
  }
}

export async function beginSignIn(party: RelyingParty) {
  const options = await generateAuthenticationOptions({ rpID: party.rpId, userVerification: "required", timeout: CHALLENGE_MS });
  const challengeId = signChallenge({ c: options.challenge, o: party.origin, r: party.rpId, n: crypto.randomBytes(16).toString("base64url"), exp: Date.now() + CHALLENGE_MS });
  return { challengeId, options };
}

/** Marks a sign-in challenge used; false if it already was. */
function consumeChallenge(nonce: string, expiresAt: number) {
  const now = Date.now();
  for (const [used, until] of usedSignIns) if (until <= now) usedSignIns.delete(used);
  if (usedSignIns.has(nonce)) return false;
  usedSignIns.set(nonce, expiresAt);
  return true;
}

const notRecognised = () => new AppError("That passkey wasn't recognised. It may have been removed, or added on a different address.", 401, "PASSKEY_INVALID");

/**
 * Checks a sign-in with a passkey and records its use. Returns the account it belongs to; the caller
 * checks the account still exists and creates the session.
 */
export async function finishSignIn(party: RelyingParty, challengeId: unknown, response: unknown) {
  const pending = readChallenge(challengeId);
  if (!pending || pending.origin !== party.origin || !consumeChallenge(pending.nonce, pending.expiresAt)) {
    throw new AppError("Signing in took too long. Try again.", 401, "PASSKEY_EXPIRED");
  }
  const body = response && typeof response === "object" ? response as { id?: unknown; response?: { userHandle?: unknown } } : null;
  if (!body || typeof body.id !== "string" || body.id.length > 1024) throw notRecognised();
  const credentialId = body.id;
  return mutate(async (passkeys) => {
    const found = passkeys.find((passkey) => passkey.id === credentialId);
    if (!found || found.rpId !== pending.rpId) throw notRecognised();
    // A discoverable passkey names its account; it must be the one it was added for.
    const suppliedHandle = body.response?.userHandle;
    if (suppliedHandle !== undefined && suppliedHandle !== found.userHandle) throw notRecognised();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        credential: { id: found.id, publicKey: new Uint8Array(Buffer.from(found.publicKey, "base64url")), counter: found.counter, transports: found.transports },
        requireUserVerification: true,
      });
    } catch {
      throw notRecognised();
    }
    if (!verification.verified) throw notRecognised();
    const used = { ...found, counter: verification.authenticationInfo.newCounter, backedUp: verification.authenticationInfo.credentialBackedUp, lastUsedAt: new Date().toISOString() };
    return { next: passkeys.map((passkey) => (passkey === found ? used : passkey)), result: { accountKey: found.account, passkey: summary(used) } };
  });
}
