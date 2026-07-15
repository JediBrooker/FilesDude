import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./http";

export interface StoredCredentials {
  username: string;
  passwordHash: string;
  version: number;
  updatedAt?: string;
}

const credentialsFile = path.join(config.stateDir, "credentials.json");

export async function getCredentials(): Promise<StoredCredentials> {
  try {
    const value = JSON.parse(await fs.readFile(credentialsFile, "utf8")) as Partial<StoredCredentials>;
    if (typeof value.username !== "string" || typeof value.passwordHash !== "string" || !Number.isInteger(value.version)) {
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

export async function saveCredentials(credentials: StoredCredentials) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `credentials-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, credentialsFile);
}
