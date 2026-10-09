import crypto from "node:crypto";

// Time-based one-time passwords (RFC 6238) as authenticator apps generate them: HMAC-SHA1, 30-second
// steps, 6 digits, with the secret shared as base32.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret, base32-encoded. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

/**
 * Checks a code against the current step and one step either side (for clock drift). Returns the
 * step it matched, or null. Steps at or before `lastUsedStep` are refused, so a code can't be reused.
 */
export function verifyTotp(secret: string, code: string, lastUsedStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate <= lastUsedStep) continue;
    const expected = Buffer.from(totpAt(secret, candidate));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return candidate;
  }
  return null;
}

/** The otpauth:// address authenticator apps read from the setup QR code. */
export function otpauthUri(secret: string, accountName: string, issuer = "FilesDude") {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
