import { type ChildProcess, type StdioOptions, execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants, fstatSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Runs ffmpeg or ffprobe on a video or audio file, or Node.js and sharp on an image (see
// image-resize.ts). They decode files that other users control, so they never run inside FilesDude:
// each run is a throwaway systemd unit running as a temporary unprivileged user with no network or
// sockets, no capabilities, a system-call filter, memory and time limits, and nothing of the
// filesystem beyond the system's programs and libraries (an empty /etc and /run, apart from what the
// dynamic linker needs and, for images, Node.js and its packages, read-only). The file is handed over as the
// already-verified open file (standard input), never as a path, so nothing can be swapped in on the
// way, and the tool may only read that file, in one of the container formats listed below: a crafted
// file can't make it open playlists, other files, or URLs. Bytes that are already in memory (a video
// frame) are handed over the same way, through a pipe.

/**
 * Runs the tool with these arguments on an open file (or these bytes), returning its output, or null
 * on failure. It is stopped after `seconds` (15 by default; reading a whole large video for its
 * subtitles needs more), or when `signal` fires.
 */
export type SandboxRun = (args: string[], input: number | Buffer, maxBytes: number, seconds?: number, signal?: AbortSignal) => Promise<Buffer | null>;

/** Where host files shown to a sandbox appear in it (its /run is otherwise empty). */
export const MOUNT_DIR = "/run/filesdude";

const DEFAULT_SECONDS = 15;
const MAX_SECONDS = 600;
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const ENV = "/usr/bin/env";

/** Container formats each use may read: video thumbnails only need the video ones. */
export const VIDEO_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi";
export const MEDIA_FORMATS = `${VIDEO_FORMATS},mp3,flac,ogg,wav,aac`;

/** Arguments every run starts with: only the passed-in file, and only these formats, are read. */
export const inputLimits = (formats: string) => ["-protocol_whitelist", "fd", "-format_whitelist", formats];

const SANDBOX = [
  "DynamicUser=yes", "PrivateNetwork=yes", "PrivateTmp=yes", "PrivateDevices=yes", "PrivateIPC=yes",
  "ProtectSystem=strict", "ProtectHome=yes", "ProtectProc=invisible", "ProcSubset=pid",
  "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes", "ProtectHostname=yes",
  "NoNewPrivileges=yes", "CapabilityBoundingSet=", "RestrictAddressFamilies=AF_UNIX", "RestrictNamespaces=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes",
  // No socket calls at all (systemd can't drop the last address family), so no host sockets either;
  // Node.js may only ask what its standard input and output are (see inspectSockets).
  "LockPersonality=yes", "SystemCallFilter=@system-service", "SystemCallFilter=~@network-io", "SystemCallArchitectures=native",
  "MemoryMax=512M", "TasksMax=64", "CPUQuota=200%",
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

export interface SandboxOptions {
  /** Host files or folders shown read-only in the sandbox, as [path on the host, path under MOUNT_DIR]. */
  mounts?: Array<[host: string, inside: string]>;
  /**
   * Asking what its standard input and output are (Node.js does, as it starts, and they are
   * sockets): it still can't make, connect, or use a socket.
   */
  inspectSockets?: boolean;
  /**
   * The tool writes to a file (its standard output) of at most this many bytes: it can't grow it
   * past that, or reserve disk space without writing (which a size check wouldn't see).
   */
  fileOutput?: number;
}

/** Disk space a file takes up, which a file with space reserved past its end can exceed its size by. */
export const diskUsage = (stat: { size: number; blocks: number }) => Math.max(stat.size, stat.blocks * 512);

// The systemd service FilesDude runs as, if it does: runs are bound to it, so they stop when it
// stops or restarts (a new FilesDude wouldn't know about them).
let ownService: string | null | undefined;
function serviceOfThisProcess() {
  if (ownService === undefined) {
    try {
      const match = /^0::\/(?:.*\/)?([A-Za-z0-9_.@-]+\.service)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"));
      ownService = match?.[1] ?? null;
    } catch {
      ownService = null;
    }
  }
  return ownService;
}

/**
 * A way to run this tool in the sandbox, or null where there is none (not Linux, not root, or
 * missing). A tool that is one of the mounts runs from where it is mounted.
 */
export async function sandboxRunner(tool: string, options: SandboxOptions = {}): Promise<SandboxRun | null> {
  const { mounts = [] } = options;
  if (process.platform !== "linux") return null;
  // Starting system units needs root; without it there is no sandbox, so the tool isn't used.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  if (!(await executable(tool)) || !(await executable(SYSTEMD_RUN))) return null;
  // systemd separates a mount's two paths with a colon.
  if (mounts.some(([host, inside]) => host.includes(":") || inside.includes(":") || !inside.startsWith(`${MOUNT_DIR}/`))) return null;
  const mounted = mounts.find(([host]) => host === tool)?.[1];
  // systemd-run looks for the program outside the sandbox, where a mounted one isn't, so env starts
  // it (with no environment at all).
  if (mounted && !(await executable(ENV))) return null;
  const command = mounted ? [ENV, "-i", mounted] : [tool];
  const hidden = hiddenPaths();
  return async (args, input, maxBytes, seconds = DEFAULT_SECONDS, signal) => {
    if (signal?.aborted) return null;
    // systemd would expand $VARIABLES in the command, changing it.
    if (args.some((arg) => arg.includes("$"))) return null;
    const limit = Number.isFinite(seconds) ? Math.min(Math.max(1, Math.round(seconds)), MAX_SECONDS) : DEFAULT_SECONDS;
    if (Buffer.isBuffer(input)) return run([...command, ...args], hidden, options, input, maxBytes, limit, signal);
    // Each run reads from its own fresh opening of the file, at its start: the tool moves the file
    // position as it reads, and an earlier run must not leave it somewhere else.
    const source = await fs.open(`/proc/self/fd/${input}`, constants.O_RDONLY | constants.O_NOCTTY).catch(() => null);
    if (!source) return null;
    try {
      const original = fstatSync(input);
      const reopened = await source.stat();
      if (!reopened.isFile() || original.dev !== reopened.dev || original.ino !== reopened.ino) return null;
      return await run([...command, ...args], hidden, options, source.fd, maxBytes, limit, signal);
    } finally {
      await source.close().catch(() => undefined);
    }
  };
}

/**
 * Runs the tool with an open file as input and another open file as its output (standard output):
 * for writing large results, such as a video repackaged to play in browsers, straight into a file
 * FilesDude opened, never by path. Stopped if the output passes `maxBytes`, after `seconds` (up to
 * four hours), or when `signal` fires. Resolves true if the tool succeeded.
 */
export type SandboxFileRun = (args: string[], input: number, output: number, maxBytes: number, seconds: number, signal?: AbortSignal) => Promise<boolean>;

const MAX_FILE_RUN_SECONDS = 4 * 60 * 60;

export async function sandboxFileRunner(tool: string): Promise<SandboxFileRun | null> {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  if (!(await executable(tool)) || !(await executable(SYSTEMD_RUN))) return null;
  const hidden = hiddenPaths();
  return async (args, input, output, maxBytes, seconds, signal) => {
    if (signal?.aborted || args.some((arg) => arg.includes("$"))) return false;
    const limit = Math.min(Math.max(1, Math.round(seconds)), MAX_FILE_RUN_SECONDS);
    const source = await fs.open(`/proc/self/fd/${input}`, constants.O_RDONLY | constants.O_NOCTTY).catch(() => null);
    if (!source) return false;
    try {
      const original = fstatSync(input);
      const reopened = await source.stat();
      if (!reopened.isFile() || original.dev !== reopened.dev || original.ino !== reopened.ino) return false;
      const unit = `filesdude-media-${crypto.randomUUID()}`;
      return await new Promise<boolean>((resolve) => {
        const child = spawn(SYSTEMD_RUN, unitArguments(unit, [tool, ...args], limit, hidden, { fileOutput: maxBytes }), { stdio: [source.fd, output, "ignore"] });
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          execFile(SYSTEMCTL, ["stop", unit], () => undefined);
          child.kill("SIGKILL");
        };
        // The output is watched as it grows, so a crafted file can't fill the disk.
        const watch = setInterval(() => {
          try {
            if (diskUsage(fstatSync(output)) > maxBytes) stop();
          } catch {
            stop();
          }
        }, 2_000);
        const timer = setTimeout(stop, (limit + 10) * 1000);
        signal?.addEventListener("abort", stop, { once: true });
        const finish = (ok: boolean) => {
          clearInterval(watch);
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          let size = 0;
          let used = Infinity;
          try {
            const stat = fstatSync(output);
            size = stat.size;
            used = diskUsage(stat);
          } catch {
            // A closed output means nothing usable was written.
          }
          resolve(ok && !stopped && size > 0 && used <= maxBytes);
        };
        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
      });
    } finally {
      await source.close().catch(() => undefined);
    }
  };
}

/** systemd-run's arguments for one run of this command, as the unit with this name. */
export function unitArguments(unit: string, command: string[], seconds: number, hidden: string[], { mounts = [], inspectSockets = false, fileOutput }: SandboxOptions = {}, service = serviceOfThisProcess()) {
  return [
    "--pipe", "--wait", "--quiet", "--collect", "--service-type=exec", `--unit=${unit}`,
    ...SANDBOX.flatMap((property) => ["-p", property]),
    ...(inspectSockets ? ["-p", "SystemCallFilter=getsockname getsockopt"] : []),
    // The kernel refuses writes past the limit; reserving space and resizing aren't allowed at all.
    ...(fileOutput !== undefined ? ["-p", `LimitFSIZE=${Math.max(1, Math.floor(fileOutput))}`, "-p", "SystemCallFilter=~fallocate ftruncate"] : []),
    ...(service ? ["-p", `BindsTo=${service}`] : []),
    "-p", `RuntimeMaxSec=${seconds}`,
    // Long runs read whole videos; they yield the disk to everything else.
    ...(seconds > DEFAULT_SECONDS ? ["-p", "IOWeight=10", "-p", "CPUWeight=20"] : []),
    ...(mounts.length ? ["-p", `BindReadOnlyPaths=${mounts.map(([host, inside]) => `${quote(host)}:${quote(inside)}`).join(" ")}`] : []),
    // Wherever the data root and state folder are, they are out of reach too.
    "-p", `InaccessiblePaths=${[...hidden, config.root, config.stateDir].map((location) => quote(`-${path.resolve(location)}`)).join(" ")}`,
    ...command,
  ];
}

function run(command: string[], hidden: string[], options: SandboxOptions, input: number | Buffer, maxBytes: number, seconds: number, signal?: AbortSignal) {
  // Each run is a named unit, so stopping it stops the tool itself, not just the client waiting on it.
  const unit = `filesdude-media-${crypto.randomUUID()}`;
  // The time limit has a backstop in case systemd's own limit doesn't stop it.
  return runProgram(SYSTEMD_RUN, unitArguments(unit, command, seconds, hidden, options), input, maxBytes, (seconds + 10) * 1000, {
    signal,
    onStop: () => execFile(SYSTEMCTL, ["stop", unit], () => undefined),
  });
}

/**
 * Runs a program with an open file (or these bytes) as its standard input, returning its standard
 * output if it succeeds with some, or null. It is killed after `limitMs`, when `signal` fires, or once
 * its output passes `maxBytes`.
 */
export function runProgram(command: string, args: string[], input: number | Buffer, maxBytes: number, limitMs: number, options: { signal?: AbortSignal; onStop?: () => void; env?: Record<string, string> } = {}) {
  return new Promise<Buffer | null>((resolve) => {
    const bytes = Buffer.isBuffer(input);
    const stdio: StdioOptions = [bytes ? "pipe" : input, "pipe", "ignore"];
    const child: ChildProcess = spawn(command, args, { stdio, env: options.env as NodeJS.ProcessEnv | undefined });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      options.onStop?.();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, limitMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (bytes) {
      // A program that stops reading early closes the pipe, which is no error of ours.
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input);
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop();
      else chunks.push(chunk);
    });
    const finish = (output: Buffer | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve(output);
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && !stopped && size > 0 ? Buffer.concat(chunks) : null));
  });
}
