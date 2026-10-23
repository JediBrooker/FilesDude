#!/usr/bin/env node
// FilesDude's commands in its Docker image (the image's entrypoint, and `filesdude` on its PATH):
//
//   start   runs FilesDude (the default)
//   setup   sets the login: the first time, or again to replace it and sign everyone out
//           (--username NAME skips that question; --rotate-secret also replaces the session secret)
//
// The container starts as root only so this can hand FilesDude's state to the account it runs as
// (PUID:PGID, its own 1001 by default); it then becomes that account, without any capabilities,
// before doing anything else. The login `setup` sets is kept in the state folder (login.env), with a
// session secret made the first time, so a container needs no secrets in its configuration. Settings
// in the container's environment win over the saved ones.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/** The settings kept in login.env; nothing else in it is read. */
export const LOGIN_KEYS = ["FILEDUDE_USERNAME", "FILEDUDE_PASSWORD_HASH", "FILEDUDE_SESSION_SECRET", "FILEDUDE_SESSION_EPOCH"];

const USAGE = "Usage: filesdude [start | setup [--username NAME] [--rotate-secret]]";
const SETUP_HINT = "docker compose run --rm filesdude setup (or: docker exec -it filesdude filesdude setup)";

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

const stateDirectory = () => path.resolve(process.env.FILEDUDE_STATE_DIR || "/state");
const managedRoot = () => path.resolve(process.env.FILEDUDE_ROOT || "/data");

function accountId(name, fallback) {
  const value = (process.env[name] ?? "").trim() || fallback;
  if (!/^\d{1,10}$/.test(value) || Number(value) > 2 ** 31 - 1) throw new Stop(`${name} must be a number (a user or group ID), not "${value}".`);
  return Number(value);
}

/**
 * Gives FilesDude's state to its account (links themselves, never what they point at, and only on the
 * state's own filesystem), and the managed folder too if it is still empty and root's, as Docker makes
 * a missing folder it mounts.
 */
function handOver(uid, gid) {
  const stateDir = stateDirectory();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const device = fs.lstatSync(stateDir).dev;
  const pending = [stateDir];
  while (pending.length) {
    const item = pending.pop();
    const stat = fs.lstatSync(item);
    if (stat.dev !== device) continue;
    if (stat.uid !== uid || stat.gid !== gid) fs.lchownSync(item, uid, gid);
    if (stat.isDirectory()) for (const name of fs.readdirSync(item)) pending.push(path.join(item, name));
  }
  const root = managedRoot();
  try {
    const stat = fs.lstatSync(root);
    if (stat.isDirectory() && stat.uid === 0 && fs.readdirSync(root).length === 0) fs.lchownSync(root, uid, gid);
  } catch {
    // A managed folder that can't be read is FilesDude's to report, once it runs.
  }
}

/** As root: hands the state over, then becomes PUID:PGID with no capabilities (unless PUID is 0). */
function becomeAccount() {
  if (process.getuid() !== 0) return;
  const uid = accountId("PUID", "1001");
  const gid = accountId("PGID", "1001");
  if (uid === 0) return;
  handOver(uid, gid);
  // Changing from root to another user ID drops every capability.
  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  process.umask(0o027);
}

async function start() {
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
    console.error(`FilesDude has no login yet, so nobody can sign in. Set one with: ${SETUP_HINT}, then restart the container.`);
  }
  await import(new URL("../server.js", import.meta.url).href);
}

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
  console.log(`The login for ${username} is saved. Start FilesDude, or restart it if it's running, to use it.`);
}

async function main() {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command !== "start" && command !== "setup") throw new Stop(USAGE);
  becomeAccount();
  if (command === "start") await start();
  else await setup(args);
}

// Run as a command (directly, or through its link on the PATH), not imported (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Stop ? error.message : error);
    process.exit(error instanceof Stop ? 64 : 1);
  });
}
