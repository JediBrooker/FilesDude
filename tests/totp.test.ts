import assert from "node:assert/strict";
import test from "node:test";
import { base32Decode, base32Encode, currentStep, otpauthUri, totpAt, verifyTotp } from "../lib/totp";

// RFC 6238 appendix B (SHA-1), whose 8-digit codes end in the 6 digits authenticator apps show.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("codes match the RFC 6238 test vectors", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(RFC_SECRET).toString(), "12345678901234567890");
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1234567890, "005924"], [2000000000, "279037"]] as const) {
    assert.equal(totpAt(RFC_SECRET, currentStep(seconds * 1000)), code, String(seconds));
  }
});

test("a code is accepted one step either side, and never twice", () => {
  const now = 1_700_000_000_000;
  const step = currentStep(now);
  for (const offset of [-1, 0, 1]) assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + offset), -1, now), step + offset);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), -1, now), null);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), step, now), null);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), step, now), step + 1);
  for (const bad of ["", "12345", "1234567", "abcdef"]) assert.equal(verifyTotp(RFC_SECRET, bad, -1, now), null);
});

test("the setup address names the issuer and account", () => {
  assert.equal(otpauthUri("ABC", "bob"), "otpauth://totp/FilesDude%3Abob?secret=ABC&issuer=FilesDude&algorithm=SHA1&digits=6&period=30");
});
