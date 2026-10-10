import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { constants, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Runs ffmpeg or ffprobe on a video or audio file, or Node.js and sharp on an image (see
// image-resize.ts). They decode files that other users control, so they never run inside FilesDude:
// each run is a throwaway systemd unit running as a temporary unprivileged user with no network or
// sockets, no capabilities, a system-call filter, memory and time limits, and nothing of the
// filesystem beyond the system's programs and libraries (an empty /etc and /run, apart from what the
// dynamic linker needs and, for images, Node.js and its packages, read-only). FilesDude doesn't run
// as root, so it can't start those units itself: a small root helper (scripts/sandbox-helper.py,
// reached through scripts/sandbox-client.py) starts them, and only with its own fixed profile, for one
// of three named tools. The file is handed over as the
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

/** Container formats each use may read: video thumbnails only need the video ones. */
export const VIDEO_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi";
export const MEDIA_FORMATS = `${VIDEO_FORMATS},mp3,flac,ogg,wav,aac`;

/** Arguments every run starts with: only the passed-in file, and only these formats, are read. */
export const inputLimits = (formats: string) => ["-protocol_whitelist", "fd", "-format_whitelist", formats];

const executable = (location: string) => fs.access(location, constants.X_OK).then(() => true, () => false);

/**
 * The tools the sandbox runs. FilesDude only names one: the sandbox helper (scripts/sandbox-helper.py,
 * running as root, as FilesDude itself doesn't) decides the program's path, the unit's locked-down
 * profile, and what's hidden from it, so nothing FilesDude does can ask for anything else.
 */
export type SandboxTool = "ffmpeg" | "ffprobe" | "node";

export interface SandboxOptions {
  /**
   * Asking what its standard input and output are (Node.js does, as it starts, and they are
   * sockets): it still can't make, connect, or use a socket.
   */
  inspectSockets?: boolean;
}

/** Disk space a file takes up, which a file with space reserved past its end can exceed its size by. */
export const diskUsage = (stat: { size: number; blocks: number }) => Math.max(stat.size, stat.blocks * 512);

const PYTHON = "/usr/bin/python3";
const socketPath = () => process.env.FILEDUDE_SANDBOX_SOCKET || "/run/filesdude-sandbox/sandbox.sock";
const clientPath = () => process.env.FILEDUDE_SANDBOX_CLIENT || path.join(process.cwd(), "scripts", "sandbox-client.py");
// The client is given nothing of FilesDude's environment but where the helper is.
const clientEnvironment = (): Record<string, string> => ({ FILEDUDE_SANDBOX_SOCKET: socketPath() });

/** Whether the sandbox helper can be reached (Linux, Python, the client, and the helper's socket). */
export async function sandboxAvailable() {
  if (process.platform !== "linux" || !(await executable(PYTHON))) return false;
  if (!(await fs.access(clientPath(), constants.R_OK).then(() => true, () => false))) return false;
  return fs.stat(socketPath()).then((stat) => stat.isSocket(), () => false);
}

/**
 * Each run reads from its own fresh opening of the file, at its start: the tool moves the file
 * position as it reads, and an earlier run must not leave it somewhere else.
 */
async function freshOpening<T>(input: number, run: (fd: number) => Promise<T>, failed: T) {
  const source = await fs.open(`/proc/self/fd/${input}`, constants.O_RDONLY | constants.O_NOCTTY).catch(() => null);
  if (!source) return failed;
  try {
    const original = fstatSync(input);
    const reopened = await source.stat();
    if (!reopened.isFile() || original.dev !== reopened.dev || original.ino !== reopened.ino) return failed;
    return await run(source.fd);
  } finally {
    await source.close().catch(() => undefined);
  }
}

/**
 * A way to run this tool in the sandbox, or null where there is none (not Linux, or no sandbox
 * helper). The open file (or bytes) and the output pipe go to the helper through its client
 * (scripts/sandbox-client.py); killing the client stops the run.
 */
export async function sandboxRunner(tool: SandboxTool, options: SandboxOptions = {}): Promise<SandboxRun | null> {
  if (!(await sandboxAvailable())) return null;
  return async (args, input, maxBytes, seconds = DEFAULT_SECONDS, signal) => {
    if (signal?.aborted) return null;
    // systemd would expand $VARIABLES in the command, changing it (the helper refuses them too).
    if (args.some((arg) => arg.includes("$"))) return null;
    const limit = Number.isFinite(seconds) ? Math.min(Math.max(1, Math.round(seconds)), MAX_SECONDS) : DEFAULT_SECONDS;
    const request = JSON.stringify({ tool, args, seconds: limit, inspectSockets: Boolean(options.inspectSockets) });
    // The time limit has a backstop in case systemd's own limit doesn't stop it.
    const start = (stdin: number | Buffer) => runProgram(PYTHON, [clientPath(), request], stdin, maxBytes, (limit + 15) * 1000, { signal, env: clientEnvironment() });
    return Buffer.isBuffer(input) ? start(input) : freshOpening(input, start, null);
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

export async function sandboxFileRunner(tool: SandboxTool): Promise<SandboxFileRun | null> {
  if (!(await sandboxAvailable())) return null;
  return async (args, input, output, maxBytes, seconds, signal) => {
    if (signal?.aborted || args.some((arg) => arg.includes("$"))) return false;
    const limit = Math.min(Math.max(1, Math.round(seconds)), MAX_FILE_RUN_SECONDS);
    // The kernel holds the output to this size, and the file can't be given space without being written.
    const request = JSON.stringify({ tool, args, seconds: limit, fileOutput: Math.max(1, Math.floor(maxBytes)) });
    return freshOpening(input, (source) => new Promise<boolean>((resolve) => {
      const stdio: StdioOptions = [source, output, "ignore"];
      const child: ChildProcess = spawn(PYTHON, [clientPath(), request], { stdio, env: clientEnvironment() as NodeJS.ProcessEnv });
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
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
      const timer = setTimeout(stop, (limit + 15) * 1000);
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
    }), false);
  };
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
