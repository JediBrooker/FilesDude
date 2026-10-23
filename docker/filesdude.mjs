#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
// FilesDude's commands in its Docker image (the image's entrypoint, and `filesdude` on its PATH):
//
//   start   runs FilesDude (the default)
//   setup   sets the login: the first time, or again to replace it and sign everyone out
//           (--username NAME skips that question; --rotate-secret also replaces the session secret)
//   health  whether FilesDude answers (the image's health check)
//
// The container starts as root only so this can hand FilesDude's state to the account it runs as
// (PUID:PGID, its own 1001 by default) and start the media sandbox's helper; it then becomes that
// account, without any capabilities, before doing anything else. The login `setup` sets is kept in
// the state folder (login.env), with a session secret made the first time, so a container needs no
// secrets in its configuration. Settings in the container's environment win over the saved ones.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/** The settings kept in login.env; nothing else in it is read. */
export const LOGIN_KEYS = ["FILEDUDE_USERNAME", "FILEDUDE_PASSWORD_HASH", "FILEDUDE_SESSION_SECRET", "FILEDUDE_SESSION_EPOCH"];

const USAGE = "Usage: filesdude [start | setup [--username NAME] [--rotate-secret] | health]";

class Stop extends Error {}

/** KEY=value lines: the login settings in them (anything else is ignored). */
export function parseLogin(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match && LOGIN_KEYS.includes(match[1]) && match[2]) values[match[1]] = match[2];
  }
  return values;
}

export function formatLogin(values) {
  return LOGIN_KEYS.filter((key) => values[key]).map((key) => `${key}=${values[key]}\n`).join("");
}

const loginFile = (stateDir) => path.join(stateDir, "login.env");

export function readLogin(stateDir) {
  try {
    return parseLogin(fs.readFileSync(loginFile(stateDir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function writeLogin(stateDir, values) {
  const temporary = path.join(stateDir, `login-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, formatLogin(values), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, loginFile(stateDir));
}

export const newSecret = () => crypto.randomBytes(48).toString("base64");

/** The same scrypt hash as scripts/hash-password.mjs and the app's own password changes. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** The saved login settings the environment doesn't already set, to be put in it. */
export function missingFromEnvironment(saved, environment) {
  return Object.fromEntries(LOGIN_KEYS.filter((key) => !environment[key] && saved[key]).map((key) => [key, saved[key]]));
}

const SANDBOX_FOLDER = "/tmp/filesdude-sandbox";
const SANDBOX_HELPER = fileURLToPath(new URL("../scripts/sandbox-helper.py", import.meta.url));
// How long the helper may take to start before FilesDude goes on without it.
const SANDBOX_START_MS = 20_000;

const stateDirectory = () => path.resolve(process.env.FILEDUDE_STATE_DIR || "/state");
const managedRoot = () => path.resolve(process.env.FILEDUDE_ROOT || "/data");

function accountId(name, fallback) {
  const value = (process.env[name] ?? "").trim() || fallback;
  if (!/^\d{1,10}$/.test(value) || Number(value) > 2 ** 31 - 1) throw new Stop(`${name} must be a number (a user or group ID), not "${value}".`);
  return Number(value);
}

/**
 * Gives FilesDude's state to its account, and the managed folder too if it is still empty and root's,
 * as Docker makes a missing folder it mounts. Everything in the state goes over only as FilesDude
 * starts; setup, which can run beside a running FilesDude (docker exec), only takes the state folder
 * itself, as FilesDude can change what's inside while root works through it.
 */
function handOver(uid, gid, { everything }) {
  const stateDir = stateDirectory();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    if (everything) {
      // chown -R works through folders it has opened, never by path, and never follows links, so
      // nothing renamed or linked along the way can send it elsewhere.
      execFileSync("chown", ["-R", "-h", "-P", `${uid}:${gid}`, stateDir], { stdio: ["ignore", "ignore", "pipe"] });
    } else {
      const stat = fs.lstatSync(stateDir);
      if (stat.uid !== uid || stat.gid !== gid) fs.lchownSync(stateDir, uid, gid);
    }
  } catch (error) {
    if (error.code === "EROFS" || /read-only file system/i.test(String(error.stderr))) {
      throw new Stop(`FilesDude's state folder (${stateDir}) is read-only: mount a volume there (compose.yaml does).`);
    }
    throw error;
  }
  const root = managedRoot();
  try {
    const stat = fs.lstatSync(root);
    if (stat.isDirectory() && stat.uid === 0 && fs.readdirSync(root).length === 0) fs.lchownSync(root, uid, gid);
  } catch {
    // A managed folder that can't be read is FilesDude's to report, once it runs.
  }
}

/**
 * As root: hands the state over (as much as `handOver` says, or none), then becomes PUID:PGID with no
 * capabilities (unless PUID is 0).
 */
function becomeAccount(handOverState) {
  if (process.getuid() !== 0) return;
  const uid = accountId("PUID", "1001");
  const gid = accountId("PGID", "1001");
  if (uid === 0) return;
  if (handOverState) handOver(uid, gid, handOverState);
  // Changing from root to another user ID drops every capability.
  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  process.umask(0o027);
}

/**
 * As root, before FilesDude starts: starts the media sandbox's helper (scripts/sandbox-helper.py
 * --container), which stays root to run (and kill) each image or video decoder as a throwaway user in
 * a root of its own, keeping only the capabilities that takes. Only FilesDude's account (and root) can reach it,
 * through a socket in a folder only PGID can enter. Resolves with the socket once the helper listens,
 * or null if the sandbox is off (the helper says why). The helper ends when FilesDude does.
 */
async function startMediaSandbox() {
  if (process.getuid() !== 0) return null;
  const uid = accountId("PUID", "1001");
  const gid = accountId("PGID", "1001");
  try {
    // Made afresh: nothing left in a /tmp that outlived an earlier start is trusted.
    fs.rmSync(SANDBOX_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(SANDBOX_FOLDER, { mode: 0o700 });
    fs.chownSync(SANDBOX_FOLDER, 0, gid);
    fs.chmodSync(SANDBOX_FOLDER, 0o710);
  } catch (error) {
    console.error(`The media sandbox is off: its folder can't be made in /tmp (${error.code}). Mount a tmpfs there (compose.yaml does).`);
    return null;
  }
  const socket = path.join(SANDBOX_FOLDER, "sandbox.sock");
  const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
  if (process.env.FILEDUDE_SANDBOX_IDS) environment.FILEDUDE_SANDBOX_IDS = process.env.FILEDUDE_SANDBOX_IDS;
  // Its standard input stays open in FilesDude, so it stops when FilesDude does.
  const helper = spawn("/usr/bin/python3", ["-I", SANDBOX_HELPER, "--container", socket, String(uid), String(gid)], { stdio: ["pipe", "inherit", "inherit"], env: environment });
  helper.stdin.on("error", () => undefined);
  return new Promise((resolve) => {
    let started = false;
    const finish = (result) => {
      clearInterval(timer);
      if (!started) resolve(result);
      started = true;
    };
    helper.on("error", () => finish(null));
    helper.on("exit", (code, signal) => {
      if (started) console.error(`The media sandbox's helper stopped (${signal ?? code}): restart the container to have it back.`);
      finish(null);
    });
    // It puts the socket in place once it's listening.
    const since = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(socket)) finish(socket);
      else if (Date.now() - since > SANDBOX_START_MS) {
        console.error("The media sandbox is off: its helper didn't start in time.");
        helper.kill("SIGKILL");
        finish(null);
      }
    }, 50);
  });
}

async function start(sandboxSocket) {
  if (sandboxSocket) process.env.FILEDUDE_SANDBOX_SOCKET = sandboxSocket;
  // Pictures are only decoded in the media sandbox: without it they get no thumbnails or details,
  // unless FILEDUDE_UNSANDBOXED_IMAGES=true (that, and nothing else) allows decoding them outside it.
  process.env.FILEDUDE_UNSANDBOXED_IMAGES = process.env.FILEDUDE_UNSANDBOXED_IMAGES === "true" ? "true" : "false";
  const stateDir = stateDirectory();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const saved = readLogin(stateDir);
  // The session secret is made the first time, and kept.
  if (!process.env.FILEDUDE_SESSION_SECRET && !saved.FILEDUDE_SESSION_SECRET) {
    saved.FILEDUDE_SESSION_SECRET = newSecret();
    writeLogin(stateDir, saved);
  }
  Object.assign(process.env, missingFromEnvironment(saved, process.env));
  if (!process.env.FILEDUDE_PASSWORD_HASH) {
    console.error("FilesDude has no login yet, so nobody can sign in. Set one with: docker exec -it filesdude filesdude setup");
  }
  await import(new URL("../server.js", import.meta.url).href);
}

/** FilesDude's own process, when setup runs in its container (docker exec), or null. */
function runningServer() {
  const account = new RegExp(`^Uid:\\s+${process.getuid()}\\s`, "m");
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      // Its account's (not the container's init, which runs as root).
      if (!account.test(fs.readFileSync(`/proc/${name}/status`, "utf8"))) continue;
      const args = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      // Next.js renames the process once it's serving.
      if (args[0].startsWith("next-server") || (args.some((arg) => arg.endsWith("/filesdude.mjs")) && args.includes("start"))) return Number(name);
    } catch {
      // Gone already.
    }
  }
  return null;
}

const running = (pid) => fs.existsSync(`/proc/${pid}`);

/** Reads a line from the terminal, showing what's typed unless `hidden`. */
function ask(question, { hidden = false } = {}) {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003" || character === "\u0004") return finish(new Stop("Cancelled."));
        if (character === "\u007f" || character === "\b") {
          if (value && !hidden) stdout.write("\b \b");
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
          if (!hidden) stdout.write(character);
        }
      }
    };
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function setup(args) {
  let username = "";
  let rotateSecret = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--username" && args[index + 1] !== undefined) username = args[++index];
    else if (args[index] === "--rotate-secret") rotateSecret = true;
    else throw new Stop(USAGE);
  }
  if (process.env.FILEDUDE_PASSWORD_HASH) {
    throw new Stop("FILEDUDE_PASSWORD_HASH is set in the container's environment, so the login set here wouldn't be used. Remove it (and FILEDUDE_USERNAME) first.");
  }
  const interactive = Boolean(process.stdin.isTTY);
  const stateDir = stateDirectory();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const saved = readLogin(stateDir);
  const credentials = path.join(stateDir, "credentials.json");
  const replacing = Boolean(saved.FILEDUDE_PASSWORD_HASH) || fs.existsSync(credentials);
  if (replacing && runningServer()) {
    console.log("FilesDude is running. If someone else may have used it, stop it first (docker compose stop) and set the login from a new container instead (docker compose run --rm filesdude setup --rotate-secret): a running FilesDude could put its own login back.");
  }
  if (replacing && interactive) {
    const answer = await ask("This replaces the login, removes its passkeys, and signs everyone out. Continue? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) throw new Stop("Nothing was changed.");
  }
  if (!username) {
    const fallback = saved.FILEDUDE_USERNAME || "admin";
    username = interactive ? (await ask(`Username [${fallback}]: `)).trim() || fallback : fallback;
  }
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Stop("The username must be 3–64 letters, numbers, dots, dashes, or underscores.");
  let password = process.env.FILEDUDE_INSTALL_PASSWORD || "";
  if (!password) {
    if (!interactive) throw new Stop("Run setup in a terminal (docker compose run, or docker exec -it), or set FILEDUDE_INSTALL_PASSWORD.");
    password = await ask("Choose a password (12+ characters): ", { hidden: true });
    if ((await ask("Confirm the password: ", { hidden: true })) !== password) throw new Stop("The passwords don't match. Nothing was changed.");
  }
  if (password.length < 12) throw new Stop("The password must contain at least 12 characters.");
  if (password.length > 512) throw new Stop("The password is too long.");

  saved.FILEDUDE_USERNAME = username;
  saved.FILEDUDE_PASSWORD_HASH = await hashPassword(password);
  if (!saved.FILEDUDE_SESSION_SECRET || rotateSecret) saved.FILEDUDE_SESSION_SECRET = newSecret();
  if (replacing) {
    // Like the installer's --reset-credentials: every session ends, and a login changed in FilesDude
    // (and its passkeys, which sign in without the password) gives way to this one.
    saved.FILEDUDE_SESSION_EPOCH = String((Number(saved.FILEDUDE_SESSION_EPOCH) || 0) + 1);
    fs.rmSync(credentials, { force: true });
    fs.rmSync(path.join(stateDir, "passkeys.json"), { force: true });
  }
  writeLogin(stateDir, saved);
  if (rotateSecret) console.log("The session secret was replaced: every share link and saved server credential has stopped working.");
  // A running FilesDude still has the old login (and sessions) until it restarts, which its container
  // does by itself when it stops (restart: unless-stopped).
  const server = runningServer();
  if (server) {
    // Said first: stopping FilesDude stops the container, and this command with it.
    console.log(`The login for ${username} is saved, and FilesDude is restarting to use it. If the container doesn't come back by itself, start it again.`);
    process.kill(server, "SIGTERM");
    for (let waited = 0; waited < 10_000 && running(server); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
    // Without an init process, FilesDude is the container's own first process, which ignores signals.
    if (running(server)) console.log("FilesDude didn't stop: restart its container (docker restart filesdude) to use the new login.");
  } else {
    console.log(`The login for ${username} is saved. Start FilesDude (or restart its container) to use it.`);
  }
}

/** Exits 0 if FilesDude answers. Run as its account, as it reads what FilesDude says. */
async function health() {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/auth/status`, { signal: AbortSignal.timeout(4_000) }).catch(() => null);
  process.exit(response?.ok ? 0 : 1);
}

async function main() {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "start") {
    const sandboxSocket = await startMediaSandbox();
    becomeAccount({ everything: true });
    await start(sandboxSocket);
  } else if (command === "setup") {
    becomeAccount({ everything: false });
    await setup(args);
  } else if (command === "health" && !args.length) {
    becomeAccount(null);
    await health();
  } else {
    throw new Stop(USAGE);
  }
}

// Run as a command (directly, or through its link on the PATH), not imported (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Stop ? error.message : error);
    process.exit(error instanceof Stop ? 64 : 1);
  });
}
