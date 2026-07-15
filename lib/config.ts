import path from "node:path";

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
};

export function configurationIssues() {
  const issues: string[] = [];
  if (!config.passwordHash) issues.push("FILEDUDE_PASSWORD_HASH is not configured");
  if (config.sessionSecret.length < 32) {
    issues.push("FILEDUDE_SESSION_SECRET must contain at least 32 characters");
  }
  return issues;
}
