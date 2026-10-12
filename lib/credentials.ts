import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, isValidPasswordHash } from "./config";
import { AppError } from "./http";

export interface StoredCredentials {
  username: string;
  passwordHash: string;
  version: number;
  updatedAt?: string;
  twoFactor?: StoredTwoFactor;
  /** Sessions renew as they're used rather than ending FILEDUDE_SESSION_HOURS after sign-in. */
  staySignedIn?: boolean;
}

/** An account's authenticator-app sign-in, stored with its credentials. */
export interface StoredTwoFactor {
  /** Base32 TOTP secret. */
  secret: string;
  /** SHA-256 hashes of the unused recovery codes. */
  recoveryCodes: string[];
  /** The last time step a code was accepted for, so no code works twice. */
  lastStep: number;
  enabledAt: string;
}

let mutationQueue: Promise<void> = Promise.resolve();

function credentialsFile() {
  return path.join(config.stateDir, "credentials.json");
}

export async function getCredentials(): Promise<StoredCredentials> {
  try {
    const value = JSON.parse(await fs.readFile(credentialsFile(), "utf8")) as Partial<StoredCredentials>;
    if (typeof value.username !== "string" || typeof value.passwordHash !== "string" || !isValidPasswordHash(value.passwordHash) || !Number.isInteger(value.version)) {
      throw new AppError("Stored account settings are invalid", 503, "CREDENTIALS_INVALID");
    }
    return value as StoredCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { username: config.username, passwordHash: config.passwordHash, version: 1 };
    }
    if (error instanceof SyntaxError) throw new AppError("Stored account settings are corrupted", 503, "CREDENTIALS_CORRUPT");
    throw error;
  }
}

export function validateUsername(username: string) {
  const normalized = username.trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalized)) {
    throw new AppError("Username must be 3–64 characters using letters, numbers, dots, dashes, or underscores", 400, "INVALID_USERNAME");
  }
  return normalized;
}

export function validateNewPassword(password: string) {
  if (password.length < 12) throw new AppError("New password must contain at least 12 characters", 400, "WEAK_PASSWORD");
  if (password.length > 512) throw new AppError("New password is too long", 400, "INVALID_PASSWORD");
}

export function hashPassword(password: string) {
  return new Promise<string>((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`scrypt$16384$8$1$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`);
    });
  });
}

/** Reads, changes, and saves the owner's credentials, one change at a time; `change` returns null to leave them as they are. */
export function updateCredentials<T>(change: (current: StoredCredentials) => Promise<{ next: StoredCredentials | null; result: T }>) {
  const run = async () => {
    const { next, result } = await change(await getCredentials());
    if (next) await saveCredentials(next);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function saveCredentials(credentials: StoredCredentials) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `credentials-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, credentialsFile());
}
