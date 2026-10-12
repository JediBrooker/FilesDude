import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, isValidPasswordHash } from "./config";
import { getCredentials, hashPassword, validateNewPassword, validateUsername, type StoredTwoFactor } from "./credentials";
import { normalizeRelative, safeResolve } from "./files";
import { AppError } from "./http";

// Accounts besides the owner (the installer's login). Each is confined to one folder and is an
// editor (can change files) or a viewer (read-only). Changing an account bumps its version, which
// signs it out everywhere.
export type UserRole = "editor" | "viewer";

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  root: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  twoFactor?: StoredTwoFactor;
  /** Sessions renew as they're used rather than ending FILEDUDE_SESSION_HOURS after sign-in. */
  staySignedIn?: boolean;
}

export type UserSummary = Omit<StoredUser, "passwordHash" | "version" | "twoFactor" | "staySignedIn"> & { twoFactor: boolean };

let mutationQueue: Promise<void> = Promise.resolve();

function usersFile() {
  return path.join(config.stateDir, "users.json");
}

function summary(user: StoredUser): UserSummary {
  return { id: user.id, username: user.username, role: user.role, root: user.root, createdAt: user.createdAt, updatedAt: user.updatedAt, twoFactor: Boolean(user.twoFactor) };
}

async function readUsers(): Promise<StoredUser[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(usersFile(), "utf8"));
    if (!Array.isArray(parsed)) throw new SyntaxError("users.json must hold a list");
    return parsed.filter((item): item is StoredUser => Boolean(item) && typeof item.id === "string" && typeof item.username === "string"
      && typeof item.passwordHash === "string" && isValidPasswordHash(item.passwordHash) && (item.role === "editor" || item.role === "viewer")
      && typeof item.root === "string" && Number.isInteger(item.version));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw new AppError("Stored user accounts are corrupted", 503, "USERS_CORRUPT");
    throw error;
  }
}

async function writeUsers(users: StoredUser[]) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `users-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(users, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, usersFile());
}

function mutate<T>(operation: (users: StoredUser[]) => Promise<{ users: StoredUser[]; result: T }>) {
  const run = async () => {
    const { users, result } = await operation(await readUsers());
    await writeUsers(users);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function validateRole(role: unknown): UserRole {
  if (role !== "editor" && role !== "viewer") throw new AppError("Choose the editor or viewer role", 400, "INVALID_ROLE");
  return role;
}

/** An account's folder must be a real folder (no symlinked component) inside the root. */
export async function validateUserRoot(root: unknown) {
  if (typeof root !== "string" || root.length > 4096) throw new AppError("Choose a folder for this account", 400, "INVALID_ROOT");
  const normalized = normalizeRelative(root).replace(/\/+$/, "");
  // An empty folder would mean the whole root, which only the owner has.
  if (!normalized) throw new AppError("Choose a folder inside the root for this account", 400, "INVALID_ROOT");
  const absolute = await safeResolve(normalized);
  if (!(await fs.stat(absolute)).isDirectory()) throw new AppError("The account's folder must be a folder", 400, "INVALID_ROOT");
  if ((await fs.realpath(absolute)) !== absolute) throw new AppError("Choose the folder's real location, not a path through a link", 400, "INVALID_ROOT");
  return normalized;
}

async function assertUsernameFree(username: string, users: StoredUser[], exceptId?: string) {
  const taken = (await getCredentials()).username.toLowerCase() === username.toLowerCase()
    || users.some((user) => user.id !== exceptId && user.username.toLowerCase() === username.toLowerCase());
  if (taken) throw new AppError("That username is already in use", 409, "USERNAME_TAKEN");
}

/** True if another account (not the owner) already uses this name; the owner checks this before renaming. */
export async function isUserUsername(username: string) {
  return (await readUsers()).some((user) => user.username.toLowerCase() === username.toLowerCase());
}

export async function listUsers() {
  return (await readUsers()).map(summary).sort((a, b) => a.username.localeCompare(b.username));
}

export async function findUserByName(username: string) {
  return (await readUsers()).find((user) => user.username === username);
}

export async function findUserById(id: string) {
  return (await readUsers()).find((user) => user.id === id);
}

export async function createUser(input: { username: unknown; password: unknown; role: unknown; root: unknown }) {
  if (typeof input.username !== "string" || typeof input.password !== "string") throw new AppError("A username and password are required", 400, "INVALID_REQUEST");
  const username = validateUsername(input.username);
  validateNewPassword(input.password);
  const role = validateRole(input.role);
  const root = await validateUserRoot(input.root);
  const passwordHash = await hashPassword(input.password);
  return mutate(async (users) => {
    await assertUsernameFree(username, users);
    const now = new Date().toISOString();
    const user: StoredUser = { id: crypto.randomBytes(9).toString("base64url"), username, passwordHash, role, root, version: 1, createdAt: now, updatedAt: now };
    return { users: [...users, user], result: summary(user) };
  });
}

export async function updateUser(id: string, changes: { role?: unknown; root?: unknown; password?: unknown }) {
  const role = changes.role === undefined ? undefined : validateRole(changes.role);
  const root = changes.root === undefined ? undefined : await validateUserRoot(changes.root);
  if (changes.password !== undefined && typeof changes.password !== "string") throw new AppError("Password is invalid", 400, "INVALID_REQUEST");
  if (typeof changes.password === "string") validateNewPassword(changes.password);
  const passwordHash = typeof changes.password === "string" ? await hashPassword(changes.password) : undefined;
  return mutate(async (users) => {
    const user = users.find((item) => item.id === id);
    if (!user) throw new AppError("That account no longer exists", 404, "NOT_FOUND");
    const updated: StoredUser = { ...user, role: role ?? user.role, root: root ?? user.root, passwordHash: passwordHash ?? user.passwordHash, version: user.version + 1, updatedAt: new Date().toISOString() };
    return { users: users.map((item) => (item.id === id ? updated : item)), result: summary(updated) };
  });
}

/** Lets an editor or viewer change their own password; returns the new version and whether they stay signed in, for their session. */
export async function changeOwnPassword(id: string, newPassword: string) {
  validateNewPassword(newPassword);
  const passwordHash = await hashPassword(newPassword);
  return mutate(async (users) => {
    const user = users.find((item) => item.id === id);
    if (!user) throw new AppError("That account no longer exists", 404, "NOT_FOUND");
    const updated = { ...user, passwordHash, version: user.version + 1, updatedAt: new Date().toISOString() };
    return { users: users.map((item) => (item.id === id ? updated : item)), result: { version: updated.version, staySignedIn: updated.staySignedIn === true } };
  });
}

/**
 * Reads, changes, and saves one account, one change at a time; `change` returns null to leave it as
 * it is. Used for two-factor sign-in, which changes the account on every code used.
 */
export async function updateUserAccount<T>(id: string, change: (user: StoredUser) => Promise<{ next: StoredUser | null; result: T }>) {
  return mutate(async (users) => {
    const user = users.find((item) => item.id === id);
    if (!user) throw new AppError("That account no longer exists", 404, "NOT_FOUND");
    const { next, result } = await change(user);
    return { users: next ? users.map((item) => (item.id === id ? next : item)) : users, result };
  });
}

export async function deleteUser(id: string) {
  return mutate(async (users) => {
    const user = users.find((item) => item.id === id);
    if (!user) throw new AppError("That account no longer exists", 404, "NOT_FOUND");
    return { users: users.filter((item) => item.id !== id), result: summary(user) };
  });
}
