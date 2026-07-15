import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const password = process.env.FILEDUDE_PASSWORD;

if (!password || password.length < 12) {
  console.error("Set FILEDUDE_PASSWORD to a password containing at least 12 characters, then run this command again.");
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);
const hash = await scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });

console.log(`FILEDUDE_PASSWORD_HASH='scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}'`);
