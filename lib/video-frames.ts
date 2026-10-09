import { spawn } from "node:child_process";
import { constants, fstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Takes one frame from a video for its thumbnail. ffmpeg decodes files that other users control, so
// it never runs inside FilesDude: each frame comes from a throwaway systemd unit running as a
// temporary unprivileged user with no network or sockets, no capabilities, a system-call filter,
// memory and time limits, and nothing of the filesystem beyond the system's programs and libraries
// (an empty /etc and /run, apart from what the dynamic linker needs). The video is handed over as
// the already-verified open file (its standard input), never as a path, so nothing can be swapped in
// on the way, and ffmpeg may only read that file, in one of the container formats listed below: a
// crafted file can't make it open playlists, other files, or URLs.

export type FrameRunner = (fd: number, seconds: number) => Promise<Buffer | null>;

const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const KILL_AFTER_MS = 25_000;
const FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi";
const SYSTEMD_RUN = "/usr/bin/systemd-run";

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

let runner: FrameRunner | null | undefined;

/** Replaces how frames are taken (tests use a fake); null means video thumbnails are off. */
export function setFrameRunner(replacement: FrameRunner | null | undefined) {
  runner = replacement;
}

const executable = (location: string) => fs.access(location, constants.X_OK).then(() => true, () => false);

async function sandboxedRunner(): Promise<FrameRunner | null> {
  if (process.env.FILEDUDE_VIDEO_THUMBNAILS === "false" || process.platform !== "linux") return null;
  // Starting system units needs root; without it there is no sandbox, so no video thumbnails.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const ffmpeg = process.env.FILEDUDE_FFMPEG_PATH || "/usr/bin/ffmpeg";
  if (!(await executable(ffmpeg)) || !(await executable(SYSTEMD_RUN))) return null;
  const hidden = hiddenPaths();
  return async (fd, seconds) => {
    // Each run reads from its own fresh opening of the video, at its start: ffmpeg moves the file
    // position as it reads, and an earlier run must not leave it somewhere else.
    const source = await fs.open(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_NOCTTY).catch(() => null);
    if (!source) return null;
    try {
      const original = fstatSync(fd);
      const reopened = await source.stat();
      if (!reopened.isFile() || original.dev !== reopened.dev || original.ino !== reopened.ino) return null;
      return await runFfmpeg(ffmpeg, hidden, source.fd, seconds);
    } finally {
      await source.close().catch(() => undefined);
    }
  };
}

// systemd splits path lists on spaces, so a path with spaces or quotes is quoted and escaped.
const quote = (word: string) => (/[\s"'\\]/.test(word) ? `"${word.replace(/["\\]/g, "\\$&")}"` : word);

function runFfmpeg(ffmpeg: string, hidden: string[], fd: number, seconds: number) {
  return new Promise<Buffer | null>((resolve) => {
    const args = [
      "--pipe", "--wait", "--quiet", "--collect", "--service-type=exec",
      ...SANDBOX.flatMap((property) => ["-p", property]),
      // Wherever the data root and state folder are, they are out of reach too.
      "-p", `InaccessiblePaths=${[...hidden, config.root, config.stateDir].map((location) => quote(`-${path.resolve(location)}`)).join(" ")}`,
      ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
      "-protocol_whitelist", "fd", "-format_whitelist", FORMATS,
      // ffmpeg would otherwise start a thread per CPU core, beyond the sandbox's task limit.
      "-threads", "2", "-ss", String(seconds), "-fd", "0", "-i", "fd:",
      "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
      "-filter_threads", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
      "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ];
    const child = spawn(SYSTEMD_RUN, args, { stdio: [fd, "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
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

async function frameRunner() {
  if (runner === undefined) runner = await sandboxedRunner();
  return runner;
}

/** Whether this server can make video thumbnails. */
export async function videoThumbnailsAvailable() {
  return (await frameRunner()) !== null;
}

/** A PNG of one frame, from a few seconds in (or the start, for short clips), or null. */
export async function videoFrame(fd: number) {
  const run = await frameRunner();
  if (!run) return null;
  return (await run(fd, 3)) ?? run(fd, 0);
}
