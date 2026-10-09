import { INPUT_LIMITS, sandboxRunner } from "./media-sandbox";

// Takes one frame from a video for its thumbnail, with ffmpeg in a throwaway sandbox (see
// media-sandbox.ts).

export type FrameRunner = (fd: number, seconds: number) => Promise<Buffer | null>;

const MAX_FRAME_BYTES = 24 * 1024 * 1024;

let runner: FrameRunner | null | undefined;

/** Replaces how frames are taken (tests use a fake); null means video thumbnails are off. */
export function setFrameRunner(replacement: FrameRunner | null | undefined) {
  runner = replacement;
}

async function sandboxedRunner(): Promise<FrameRunner | null> {
  if (process.env.FILEDUDE_VIDEO_THUMBNAILS === "false") return null;
  const run = await sandboxRunner(process.env.FILEDUDE_FFMPEG_PATH || "/usr/bin/ffmpeg");
  if (!run) return null;
  return (fd, seconds) => run([
    "-nostdin", "-hide_banner", "-loglevel", "error", ...INPUT_LIMITS,
    // ffmpeg would otherwise start a thread per CPU core, beyond the sandbox's task limit.
    "-threads", "2", "-ss", String(seconds), "-fd", "0", "-i", "fd:",
    "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
    "-filter_threads", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
    "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ], fd, MAX_FRAME_BYTES);
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
