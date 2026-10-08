import path from "node:path";

export const EXAMPLE_PASSWORD_HASH = "scrypt$16384$8$1$replace-with-generated-value";
export const EXAMPLE_SESSION_SECRET = "replace-with-at-least-32-random-characters";

const root = path.resolve(/* turbopackIgnore: true */ process.env.FILEDUDE_ROOT || path.join(process.cwd(), "demo-root"));

export const config = {
  root,
  stateDir: path.resolve(process.env.FILEDUDE_STATE_DIR || path.join(root, ".filedude")),
  username: process.env.FILEDUDE_USERNAME || "admin",
  passwordHash: process.env.FILEDUDE_PASSWORD_HASH || "",
  sessionSecret: process.env.FILEDUDE_SESSION_SECRET || "",
  sessionHours: Math.max(1, Number(process.env.FILEDUDE_SESSION_HOURS || 12)),
  maxUploadBytes: Math.max(1, Number(process.env.FILEDUDE_MAX_UPLOAD_MB || 512)) * 1024 * 1024,
  trustProxy: process.env.FILEDUDE_TRUST_PROXY === "true",
  trashEnabled: process.env.FILEDUDE_TRASH_ENABLED !== "false",
  sharingEnabled: process.env.FILEDUDE_SHARING_ENABLED !== "false",
};

export function isValidPasswordHash(encoded: string) {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw, extra] = encoded.split("$");
  if (extra !== undefined || algorithm !== "scrypt" || nRaw !== "16384" || rRaw !== "8" || pRaw !== "1") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(saltRaw || "") || !/^[A-Za-z0-9_-]+$/.test(hashRaw || "")) return false;
  return Buffer.from(saltRaw, "base64url").length === 16 && Buffer.from(hashRaw, "base64url").length === 32;
}

export function configurationIssues() {
  const issues: string[] = [];
  if (config.stateDir === config.root) issues.push("FILEDUDE_STATE_DIR must not be the managed root");
  if (!config.passwordHash) issues.push("FILEDUDE_PASSWORD_HASH is not configured");
  else if (config.passwordHash === EXAMPLE_PASSWORD_HASH || !isValidPasswordHash(config.passwordHash)) {
    issues.push("FILEDUDE_PASSWORD_HASH must be replaced with a generated hash");
  }
  if (config.sessionSecret === EXAMPLE_SESSION_SECRET) {
    issues.push("FILEDUDE_SESSION_SECRET must be replaced with a random value");
  } else if (config.sessionSecret.length < 32) {
    issues.push("FILEDUDE_SESSION_SECRET must contain at least 32 characters");
  }
  return issues;
}
