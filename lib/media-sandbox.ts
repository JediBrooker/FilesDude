import { spawn } from "node:child_process";
import { constants, fstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Runs ffmpeg or ffprobe on a video or audio file. They decode files that other users control, so
// they never run inside FilesDude: each run is a throwaway systemd unit running as a temporary
// unprivileged user with no network or sockets, no capabilities, a system-call filter, memory and
// time limits, and nothing of the filesystem beyond the system's programs and libraries (an empty
// /etc and /run, apart from what the dynamic linker needs). The file is handed over as the
// already-verified open file (standard input), never as a path, so nothing can be swapped in on the
// way, and the tool may only read that file, in one of the container formats listed below: a crafted
// file can't make it open playlists, other files, or URLs.

/** Runs the tool with these arguments on an open file, returning its output, or null on failure. */
export type SandboxRun = (args: string[], fd: number, maxBytes: number) => Promise<Buffer | null>;

const KILL_AFTER_MS = 25_000;
const SYSTEMD_RUN = "/usr/bin/systemd-run";

/** Arguments every run starts with: only the passed-in file, and only these formats, are read. */
export const INPUT_LIMITS = ["-protocol_whitelist", "fd", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mp3,flac,ogg,wav,aac"];

const SANDBOX = [
  "DynamicUser=yes", "PrivateNetwork=yes", "PrivateTmp=yes", "PrivateDevices=yes", "PrivateIPC=yes",
  "ProtectSystem=strict", "ProtectHome=yes", "ProtectProc=invisible", "ProcSubset=pid",
  "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes", "ProtectHostname=yes",
  "NoNewPrivileges=yes", "CapabilityBoundingSet=", "RestrictAddressFamilies=AF_UNIX", "RestrictNamespaces=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes",
  // No socket calls at all (systemd can't drop the last address family), so no host sockets either.
  "LockPersonality=yes", "SystemCallFilter=@system-service", "SystemCallFilter=~@network-io", "SystemCallArchitectures=native",
  "MemoryMax=512M", "TasksMax=64", "RuntimeMaxSec=15", "CPUQuota=200%",
  "TemporaryFileSystem=/etc:ro /run:ro", "BindReadOnlyPaths=-/etc/ld.so.cache -/etc/alternatives",
];

// Top-level folders the sandbox keeps: the system's programs and libraries (often symlinks into
// /usr), and the kernel and temporary filesystems the sandbox already replaces with its own.
const KEPT = new Set(["usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "proc", "dev", "tmp", "etc", "run"]);

/** Everything else at the top of the filesystem is hidden, whatever this host has there. */
export function hiddenPaths(entries = readdirSync("/", { withFileTypes: true })) {
  return entries.filter((entry) => !entry.isSymbolicLink() && !KEPT.has(entry.name)).map((entry) => `/${entry.name}`);
}

const executable = (location: string) => fs.access(location, constants.X_OK).then(() => true, () => false);

// systemd splits path lists on spaces, so a path with spaces or quotes is quoted and escaped.
const quote = (word: string) => (/[\s"'\\]/.test(word) ? `"${word.replace(/["\\]/g, "\\$&")}"` : word);

/** A way to run this tool in the sandbox, or null where there is none (not Linux, not root, or missing). */
export async function sandboxRunner(tool: string): Promise<SandboxRun | null> {
  if (process.platform !== "linux") return null;
  // Starting system units needs root; without it there is no sandbox, so the tool isn't used.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  if (!(await executable(tool)) || !(await executable(SYSTEMD_RUN))) return null;
  const hidden = hiddenPaths();
  return async (args, fd, maxBytes) => {
    // Each run reads from its own fresh opening of the file, at its start: the tool moves the file
    // position as it reads, and an earlier run must not leave it somewhere else.
    const source = await fs.open(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_NOCTTY).catch(() => null);
    if (!source) return null;
    try {
      const original = fstatSync(fd);
      const reopened = await source.stat();
      if (!reopened.isFile() || original.dev !== reopened.dev || original.ino !== reopened.ino) return null;
      return await run(tool, hidden, args, source.fd, maxBytes);
    } finally {
      await source.close().catch(() => undefined);
    }
  };
}

function run(tool: string, hidden: string[], toolArgs: string[], fd: number, maxBytes: number) {
  return new Promise<Buffer | null>((resolve) => {
    const args = [
      "--pipe", "--wait", "--quiet", "--collect", "--service-type=exec",
      ...SANDBOX.flatMap((property) => ["-p", property]),
      // Wherever the data root and state folder are, they are out of reach too.
      "-p", `InaccessiblePaths=${[...hidden, config.root, config.stateDir].map((location) => quote(`-${path.resolve(location)}`)).join(" ")}`,
      tool, ...toolArgs,
    ];
    const child = spawn(SYSTEMD_RUN, args, { stdio: [fd, "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        child.kill("SIGKILL");
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !tooBig && size > 0 ? Buffer.concat(chunks) : null);
    });
  });
}
