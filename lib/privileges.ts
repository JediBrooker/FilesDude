import { readFileSync } from "node:fs";

// FilesDude runs as its own ordinary account with a few file capabilities (see install.sh): changing
// owners (CAP_CHOWN), and reading and writing files whatever their permissions. Older installs, and
// some setups, run it as root instead, which has them all.

const CAP_CHOWN = BigInt(0);
const NONE = BigInt(0);
const ALL = (BigInt(1) << BigInt(64)) - BigInt(1);

const runningAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

let capabilities: bigint | undefined;

/** The effective capabilities in a /proc/<pid>/status file (none if it doesn't say). */
export function capabilitiesFrom(status: string) {
  const line = status.split("\n").find((item) => item.startsWith("CapEff:"));
  const value = line?.slice("CapEff:".length).trim() ?? "";
  return /^[0-9a-f]{1,16}$/i.test(value) ? BigInt(`0x${value}`) : NONE;
}

/** Whether these capabilities include changing owners. */
export const includesChown = (set: bigint) => (set & (BigInt(1) << CAP_CHOWN)) !== NONE;

/** This process's effective capabilities (all of them for root; none where they can't be read). */
function effectiveCapabilities() {
  if (capabilities !== undefined) return capabilities;
  capabilities = NONE;
  if (process.platform === "linux") {
    try {
      capabilities = capabilitiesFrom(readFileSync("/proc/self/status", "utf8"));
    } catch {
      // No /proc: treated as having none, unless running as root.
    }
  }
  if (runningAsRoot() && capabilities === NONE) capabilities = ALL;
  return capabilities;
}

/** Whether FilesDude can give files and folders to other owners (root, or CAP_CHOWN). */
export function canChangeOwnership() {
  return runningAsRoot() || includesChown(effectiveCapabilities());
}

/**
 * Whether FilesDude can reach more than its own account's files (root, or any capability): programs
 * it starts would inherit that, so nothing it decodes for other people may run as one of them.
 */
export function privileged() {
  return runningAsRoot() || effectiveCapabilities() !== NONE;
}
