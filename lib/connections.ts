import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ssh2 from "ssh2";
import { config } from "./config";
import { AppError } from "./http";

/**
 * Other servers the owner connects to over SFTP. Each is stored in the state directory with its
 * credentials (a password, or a private key, which FilesDude can generate so only the public half
 * ever leaves the server) encrypted with a key derived from the session secret. Credentials are
 * never sent back to the browser. The server's host key is trusted on first connection only once
 * the owner confirms its fingerprint, and any later change is refused.
 */
export type ConnectionAuth = "key" | "password";
type Secret = { password?: string; privateKey?: string; passphrase?: string };
type StoredConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: ConnectionAuth;
  /** The starting folder on the server (absolute), or "" for the account's home folder. */
  root: string;
  /** The SHA256 fingerprint of the server's host key, once the owner has confirmed it. */
  hostKey?: string;
  /** For a key FilesDude generated, the public half to add to the server's authorized_keys. */
  publicKey?: string;
  secret: string;
  createdAt: string;
  updatedAt: string;
};
export type Connection = Omit<StoredConnection, "secret"> & { hasSecret: boolean };
export type ConnectionSettings = Pick<StoredConnection, "id" | "host" | "port" | "username" | "auth" | "root" | "hostKey"> & Secret;

const MAX_CONNECTIONS = 50;
// ssh2 is a CommonJS package, so its parts come from the default export.
const { utils } = ssh2;

function storePath() {
  return path.join(config.stateDir, "connections.json");
}

// Credentials are encrypted at rest (AES-256-GCM) with a key only this installation has.
function secretKey() {
  return Buffer.from(crypto.hkdfSync("sha256", config.sessionSecret, "filesdude-connections", "credentials v1", 32));
}

function seal(secret: Secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

function open(sealed: string): Secret {
  try {
    const [iv, tag, data] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  } catch {
    throw new AppError("This server's saved credentials can't be read (was the session secret changed?). Edit the server and enter them again.", 409, "CREDENTIALS_UNREADABLE");
  }
}

async function readStore(): Promise<StoredConnection[]> {
  const text = await fs.readFile(storePath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? (parsed as StoredConnection[]) : [];
}

let queue: Promise<unknown> = Promise.resolve();

// Changes are made one at a time and written atomically, readable only by this service.
function mutate<T>(change: (connections: StoredConnection[]) => Promise<{ next: StoredConnection[]; result: T }> | { next: StoredConnection[]; result: T }) {
  const run = queue.then(async () => {
    const { next, result } = await change(await readStore());
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${storePath()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, storePath());
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

const toPublic = ({ secret, ...connection }: StoredConnection): Connection => ({ ...connection, hasSecret: Boolean(secret) });

export async function listConnections() {
  return (await readStore()).map(toPublic).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getConnection(id: string) {
  const found = (await readStore()).find((connection) => connection.id === id);
  if (!found) throw new AppError("That server is no longer set up", 404, "CONNECTION_NOT_FOUND");
  return found;
}

/** What connecting needs, with the credentials decrypted. Server-side only. */
export async function connectionSettings(id: string): Promise<ConnectionSettings> {
  const found = await getConnection(id);
  return { id: found.id, host: found.host, port: found.port, username: found.username, auth: found.auth, root: found.root, hostKey: found.hostKey, ...open(found.secret) };
}

/** OpenSSH-style fingerprint of a raw host key: "SHA256:" and unpadded base64. */
export function fingerprint(hostKey: Buffer) {
  return `SHA256:${crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

export type ConnectionInput = {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  auth?: unknown;
  root?: unknown;
  password?: unknown;
  privateKey?: unknown;
  passphrase?: unknown;
  /** For auth "key" with no private key given: generate one. */
  generateKey?: unknown;
};

function text(value: unknown, label: string, pattern: RegExp, max: number) {
  if (typeof value !== "string") throw new AppError(`Enter the ${label}`, 400, "INVALID_CONNECTION");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || !pattern.test(trimmed)) throw new AppError(`The ${label} isn't valid`, 400, "INVALID_CONNECTION");
  return trimmed;
}

function remoteRoot(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0") || !value.startsWith("/")) throw new AppError("The starting folder must be a full path starting with /, or empty for the home folder", 400, "INVALID_CONNECTION");
  const normalized = path.posix.normalize(value);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function validate(input: ConnectionInput) {
  const name = text(input.name, "name", /^[^\u0000-\u001f\u007f]+$/, 64);
  // A host name or an IP address; brackets around IPv6 are dropped.
  const host = text(input.host, "host", /^\[?[A-Za-z0-9.:-]+\]?$/, 255).replace(/^\[(.*)\]$/, "$1");
  const port = input.port === undefined || input.port === "" ? 22 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("The port isn't valid", 400, "INVALID_CONNECTION");
  const username = text(input.username, "username", /^[A-Za-z0-9._@+-]+$/, 64);
  if (input.auth !== "key" && input.auth !== "password") throw new AppError("Choose how to sign in", 400, "INVALID_CONNECTION");
  return { name, host, port, username, auth: input.auth as ConnectionAuth, root: remoteRoot(input.root) };
}

// A new key pair for FilesDude to sign in with; the owner adds the public half on the server.
function generateKeyPair(name: string) {
  const pair = utils.generateKeyPairSync("ed25519", { comment: `filesdude ${name}`.replace(/[^\x20-\x7e]/g, "") });
  return { privateKey: pair.private, publicKey: pair.public };
}

function checkPrivateKey(privateKey: string, passphrase?: string) {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error || (Array.isArray(parsed) ? !parsed.length : !parsed)) throw new AppError("That private key couldn't be read (check its passphrase)", 400, "INVALID_KEY");
}

/** Builds the credentials from the input; without new ones, an existing connection keeps its own. */
function credentials(input: ConnectionInput, settings: ReturnType<typeof validate>, existing?: StoredConnection) {
  if (settings.auth === "password") {
    if (typeof input.password === "string" && input.password) {
      if (input.password.length > 1024) throw new AppError("The password is too long", 400, "INVALID_CONNECTION");
      return { secret: seal({ password: input.password }), publicKey: undefined };
    }
    if (existing?.auth === "password") return { secret: existing.secret, publicKey: undefined };
    throw new AppError("Enter the password", 400, "INVALID_CONNECTION");
  }
  if (typeof input.privateKey === "string" && input.privateKey.trim()) {
    const passphrase = typeof input.passphrase === "string" && input.passphrase ? input.passphrase : undefined;
    if (input.privateKey.length > 16_384) throw new AppError("That private key is too long", 400, "INVALID_KEY");
    checkPrivateKey(input.privateKey, passphrase);
    return { secret: seal({ privateKey: input.privateKey, passphrase }), publicKey: undefined };
  }
  if (existing?.auth === "key" && !input.generateKey) return { secret: existing.secret, publicKey: existing.publicKey };
  const pair = generateKeyPair(settings.name);
  return { secret: seal({ privateKey: pair.privateKey }), publicKey: pair.publicKey };
}

export async function createConnection(input: ConnectionInput) {
  const settings = validate(input);
  return mutate((connections) => {
    if (connections.length >= MAX_CONNECTIONS) throw new AppError(`Set up at most ${MAX_CONNECTIONS} servers`, 409, "TOO_MANY_CONNECTIONS");
    const now = new Date().toISOString();
    const stored: StoredConnection = { id: crypto.randomUUID(), ...settings, ...credentials(input, settings), createdAt: now, updatedAt: now };
    return { next: [...connections, stored], result: toPublic(stored) };
  });
}

export async function updateConnection(id: string, input: ConnectionInput) {
  const settings = validate(input);
  return mutate((connections) => {
    const index = connections.findIndex((connection) => connection.id === id);
    if (index < 0) throw new AppError("That server is no longer set up", 404, "CONNECTION_NOT_FOUND");
    const existing = connections[index];
    // A different server (host or port) has to have its identity confirmed again.
    const sameServer = existing.host === settings.host && existing.port === settings.port;
    const updated: StoredConnection = { ...existing, ...settings, ...credentials(input, settings, existing), hostKey: sameServer ? existing.hostKey : undefined, updatedAt: new Date().toISOString() };
    const next = [...connections];
    next[index] = updated;
    return { next, result: toPublic(updated) };
  });
}

export async function deleteConnection(id: string) {
  return mutate((connections) => {
    const found = connections.find((connection) => connection.id === id);
    if (!found) throw new AppError("That server is no longer set up", 404, "CONNECTION_NOT_FOUND");
    return { next: connections.filter((connection) => connection.id !== id), result: toPublic(found) };
  });
}

/** Records the host key fingerprint the owner confirmed. */
export async function trustHostKey(id: string, hostKey: string) {
  if (typeof hostKey !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) throw new AppError("That fingerprint isn't valid", 400, "INVALID_FINGERPRINT");
  return mutate((connections) => {
    const index = connections.findIndex((connection) => connection.id === id);
    if (index < 0) throw new AppError("That server is no longer set up", 404, "CONNECTION_NOT_FOUND");
    const next = [...connections];
    next[index] = { ...connections[index], hostKey, updatedAt: new Date().toISOString() };
    return { next, result: toPublic(next[index]) };
  });
}
