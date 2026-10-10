import path from "node:path";
import type { Readable, Writable } from "node:stream";
import ssh2, { type Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper, type Stats } from "ssh2";
import { connectionSettings, fingerprint, type ConnectionSettings } from "./connections";
import { getMime } from "./files";
import { AppError } from "./http";

/**
 * SFTP sessions to the owner's other servers, kept open briefly between requests. Every connection
 * checks the server's host key against the confirmed fingerprint. Paths are relative to the server's
 * starting folder and can't climb above it.
 */
export type RemoteEntry = { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number; modified: string; mode: string; uid: number; gid: number; mime: string };

const READY_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 60_000;
const MAX_LISTING = 10_000;

type Session = { client: Client; sftp: SFTPWrapper; root: string; users: number; idle?: NodeJS.Timeout; closed: boolean };
const sessions = new Map<string, Promise<Session>>();

function sshError(error: unknown, settings: ConnectionSettings): AppError {
  if (error instanceof AppError) return error;
  const message = (error as Error)?.message ?? String(error);
  const level = (error as { level?: string })?.level;
  if (level === "client-authentication") return new AppError(`${settings.username}@${settings.host} refused the sign-in. Check the password, or that FilesDude's public key is in ~/.ssh/authorized_keys there.`, 401, "REMOTE_AUTH_FAILED");
  if (/Timed out/i.test(message)) return new AppError(`${settings.host} didn't respond in time`, 504, "REMOTE_TIMEOUT");
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return new AppError(`${settings.host} couldn't be found`, 502, "REMOTE_NOT_FOUND");
  if (/ECONNREFUSED/.test(message)) return new AppError(`${settings.host} refused the connection on port ${settings.port}`, 502, "REMOTE_REFUSED");
  if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return new AppError(`${settings.host} can't be reached`, 502, "REMOTE_UNREACHABLE");
  return new AppError(`The connection to ${settings.host} failed: ${message}`, 502, "REMOTE_FAILED");
}

/**
 * Connects, checking the host key. With no confirmed fingerprint, or a different one, it stops
 * before signing in and reports the fingerprint the server presented.
 */
function connect(settings: ConnectionSettings): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let presented = "";
    const options: ConnectConfig = {
      host: settings.host,
      port: settings.port,
      username: settings.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        presented = fingerprint(key);
        return Boolean(settings.hostKey) && presented === settings.hostKey;
      },
      ...(settings.auth === "password" ? { password: settings.password } : { privateKey: settings.privateKey, passphrase: settings.passphrase }),
    };
    client.once("ready", () => {
      client.sftp((error, sftp) => {
        if (error) {
          client.end();
          reject(sshError(error, settings));
        } else {
          resolve({ client, sftp });
        }
      });
    });
    client.once("error", (error) => {
      client.end();
      if (presented && presented !== settings.hostKey) {
        reject(Object.assign(settings.hostKey
          ? new AppError(`${settings.host}'s identity has changed: it presented ${presented}, not the confirmed ${settings.hostKey}. If the server was reinstalled, confirm the new fingerprint; otherwise someone may be intercepting the connection.`, 409, "HOST_KEY_CHANGED")
          : new AppError(`Confirm ${settings.host}'s fingerprint before connecting`, 409, "HOST_KEY_UNKNOWN"), { fingerprint: presented }));
        return;
      }
      reject(sshError(error, settings));
    });
    client.connect(options);
  });
}

// Paths are relative to the starting folder; climbing above it is refused.
export function remotePath(root: string, relative: string) {
  if (typeof relative !== "string" || relative.length > 4096 || relative.includes("\0")) throw new AppError("Invalid path", 400, "INVALID_PATH");
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new AppError("Invalid path", 400, "INVALID_PATH");
  return path.posix.join(root || "/", ...parts);
}

const call = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value as T))));

async function openSession(id: string): Promise<Session> {
  const settings = await connectionSettings(id);
  const { client, sftp } = await connect(settings);
  const root = settings.root || (await call<string>((done) => sftp.realpath(".", done)).catch(() => "/"));
  const session: Session = { client, sftp, root, users: 0, closed: false };
  // A dropped connection is forgotten, so the next request opens a new one.
  const forget = () => {
    session.closed = true;
    void sessions.get(id)?.then((current) => { if (current === session) sessions.delete(id); }, () => undefined);
  };
  client.on("close", forget);
  client.on("error", forget);
  return session;
}

/** Closes the server's session (after its settings change or it's removed). */
export async function closeSession(id: string) {
  const pending = sessions.get(id);
  sessions.delete(id);
  const session = await pending?.catch(() => null);
  if (session && !session.closed) session.client.end();
}

/** Runs `run` with an SFTP session to the server, reusing one opened in the last minute. */
export async function withSftp<T>(id: string, run: (sftp: SFTPWrapper, root: string) => Promise<T>): Promise<T> {
  let pending = sessions.get(id);
  if (!pending) {
    pending = openSession(id);
    sessions.set(id, pending);
    pending.catch(() => { if (sessions.get(id) === pending) sessions.delete(id); });
  }
  const session = await pending;
  if (session.closed) {
    sessions.delete(id);
    return withSftp(id, run);
  }
  session.users += 1;
  clearTimeout(session.idle);
  try {
    return await run(session.sftp, session.root);
  } catch (error) {
    throw remoteError(error);
  } finally {
    session.users -= 1;
    if (!session.users) session.idle = setTimeout(() => void closeSession(id), IDLE_CLOSE_MS).unref();
  }
}

/** Connects once to check the settings work, reporting the server's fingerprint either way. */
export async function testConnection(id: string) {
  const settings = await connectionSettings(id);
  await closeSession(id);
  const { client, sftp } = await connect(settings);
  try {
    const home = settings.root || (await call<string>((done) => sftp.realpath(".", done)));
    await call<Stats>((done) => sftp.stat(home, done));
    return { ok: true, root: home };
  } finally {
    client.end();
  }
}

// SFTP status errors in words.
export function remoteError(error: unknown) {
  if (error instanceof AppError) return error;
  const code = (error as { code?: number })?.code;
  const message = (error as Error)?.message ?? String(error);
  if (code === 2) return new AppError("That file or folder no longer exists on the server", 404, "REMOTE_NOT_FOUND");
  if (code === 3) return new AppError("The server refused permission for that", 403, "REMOTE_PERMISSION");
  return new AppError(`The server reported an error: ${message}`, 502, "REMOTE_ERROR");
}

function typeOf(stats: Stats): RemoteEntry["type"] {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function entryOf(name: string, relative: string, stats: Stats): RemoteEntry {
  return {
    name,
    path: relative,
    type: typeOf(stats),
    size: Number(stats.size ?? 0),
    modified: new Date((stats.mtime ?? 0) * 1000).toISOString(),
    mode: ((stats.mode ?? 0) & 0o7777).toString(8).padStart(3, "0"),
    uid: stats.uid ?? 0,
    gid: stats.gid ?? 0,
    mime: stats.isDirectory() ? "inode/directory" : getMime(name),
  };
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** A folder's contents on the server. */
export async function listRemote(id: string, relative: string) {
  return withSftp(id, async (sftp, root) => {
    const entries = await call<FileEntryWithStats[]>((done) => sftp.readdir(remotePath(root, relative), done));
    const folder = relative.split("/").filter((part) => part && part !== ".").join("/");
    const list = entries.filter((entry) => entry.filename !== "." && entry.filename !== ".." && !entry.filename.includes("/")).slice(0, MAX_LISTING);
    return { root, path: folder, truncated: entries.length > MAX_LISTING, entries: list.map((entry) => entryOf(entry.filename, join(folder, entry.filename), entry.attrs)) };
  });
}

export async function statRemote(sftp: SFTPWrapper, absolute: string) {
  return call<Stats>((done) => sftp.lstat(absolute, done));
}

export const remoteExists = (sftp: SFTPWrapper, absolute: string) => statRemote(sftp, absolute).then(() => true, (error: { code?: number }) => {
  if (error?.code === 2) return false;
  throw error;
});

// A name in the folder that nothing has yet: "name (1).ext" and so on.
export async function availableRemoteName(sftp: SFTPWrapper, folder: string, name: string) {
  const extension = path.posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = index ? `${stem} (${index})${extension}` : name;
    if (!(await remoteExists(sftp, path.posix.join(folder, candidate)))) return candidate;
  }
  throw new AppError("Unable to choose an available name on the server", 409);
}

/** A name given for something on the server: one level, nothing special. */
export function remoteName(name: unknown) {
  if (typeof name !== "string") throw new AppError("Enter a name", 400, "INVALID_NAME");
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\0]/.test(trimmed) || Buffer.byteLength(trimmed) > 255) throw new AppError("Enter a valid name without slashes", 400, "INVALID_NAME");
  return trimmed;
}

export async function makeRemoteFolder(id: string, parent: string, name: unknown) {
  const folderName = remoteName(name);
  return withSftp(id, async (sftp, root) => {
    const target = path.posix.join(remotePath(root, parent), folderName);
    if (await remoteExists(sftp, target)) throw new AppError("Something with that name already exists there", 409, "REMOTE_EXISTS");
    await call<void>((done) => sftp.mkdir(target, done));
    return join(parent, folderName);
  });
}

export async function renameRemote(id: string, relative: string, name: unknown) {
  const newName = remoteName(name);
  return withSftp(id, async (sftp, root) => {
    const source = remotePath(root, relative);
    if (source === (root || "/")) throw new AppError("The starting folder can't be renamed here", 400, "INVALID_PATH");
    const target = path.posix.join(path.posix.dirname(source), newName);
    if (target !== source && (await remoteExists(sftp, target))) throw new AppError("Something with that name already exists there", 409, "REMOTE_EXISTS");
    await call<void>((done) => sftp.rename(source, target, done));
    return join(path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative), newName);
  });
}

const MAX_DELETE_ENTRIES = 100_000;

/** Removes a file, link, or folder with everything in it, through this session; returns how many items. */
export async function removeRemoteTree(sftp: SFTPWrapper, absolute: string, signal?: AbortSignal) {
  let removed = 0;
  const remove = async (location: string, depth: number): Promise<void> => {
    if (signal?.aborted) throw new AppError("The delete was cancelled", 499, "CANCELLED");
    if (removed >= MAX_DELETE_ENTRIES || depth > 64) throw new AppError("That folder is too large to delete from here", 400, "TOO_LARGE");
    const stats = await statRemote(sftp, location);
    if (stats.isDirectory()) {
      for (const entry of await call<FileEntryWithStats[]>((done) => sftp.readdir(location, done))) {
        if (entry.filename === "." || entry.filename === ".." || entry.filename.includes("/")) continue;
        await remove(path.posix.join(location, entry.filename), depth + 1);
      }
      await call<void>((done) => sftp.rmdir(location, done));
    } else {
      // Files and links alike: a link is removed, never what it points to.
      await call<void>((done) => sftp.unlink(location, done));
    }
    removed += 1;
  };
  await remove(absolute, 0);
  return removed;
}

/** Deletes files and folders (with everything in them) on the server. There is no trash there. */
export async function deleteRemote(id: string, relatives: string[], signal?: AbortSignal) {
  return withSftp(id, async (sftp, root) => {
    let removed = 0;
    for (const relative of relatives) {
      const absolute = remotePath(root, relative);
      if (absolute === (root || "/")) throw new AppError("The starting folder can't be deleted here", 400, "INVALID_PATH");
      removed += await removeRemoteTree(sftp, absolute, signal);
    }
    return removed;
  });
}

export { call as sftpCall };

/** A stream of a file on the server (optionally a byte range), with its size. */
export async function readRemote(id: string, relative: string, range?: { start: number; end: number }) {
  // The session is held until the stream ends.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return new Promise<{ stream: Readable; size: number; name: string }>((resolve, reject) => {
    withSftp(id, async (sftp, root) => {
      const absolute = remotePath(root, relative);
      const stats = await call<Stats>((done) => sftp.stat(absolute, done));
      if (!stats.isFile()) throw new AppError("Only files can be opened", 400, "NOT_A_FILE");
      const stream = sftp.createReadStream(absolute, range ? { start: range.start, end: range.end } : {});
      stream.once("close", release);
      stream.once("error", release);
      resolve({ stream, size: Number(stats.size), name: path.posix.basename(absolute) });
      await held;
    }).catch(reject);
  });
}

/**
 * Writes a stream to a new file in a folder on the server: to a temporary name first, renamed to a
 * name nothing has ("name (1).ext") once complete, and removed if anything goes wrong.
 */
export async function writeRemote(sftp: SFTPWrapper, folder: string, name: string, write: (target: Writable) => Promise<void>) {
  const temporary = path.posix.join(folder, `.filesdude-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const stream = sftp.createWriteStream(temporary, { flags: "wx", mode: 0o644 });
  try {
    await write(stream);
    // The server has the whole file once the stream has closed its handle.
    await new Promise<void>((resolve, reject) => {
      if (stream.closed) return resolve();
      stream.once("close", resolve);
      stream.once("error", reject);
    });
    const chosen = await availableRemoteName(sftp, folder, name);
    await call<void>((done) => sftp.rename(temporary, path.posix.join(folder, chosen), done));
    return chosen;
  } catch (error) {
    stream.destroy();
    await call<void>((done) => sftp.unlink(temporary, done)).catch(() => undefined);
    throw error;
  }
}
