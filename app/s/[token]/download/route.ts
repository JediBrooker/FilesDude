import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { appendDirectory, reservedPathCheck } from "@/lib/archives";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/auth";
import { acquireFilesystemLock, getMime } from "@/lib/files";
import { isUnlocked, isUploadShare, openSharedItem, recordShareDownload, resolveShareToken } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public and unauthenticated: everything is served as a download, never rendered, so a shared
// HTML or SVG file cannot run script on this origin.
const baseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Robots-Tag": "noindex, nofollow",
};
// Folder ZIPs are built on the fly; cap how many anonymous visitors can make the server do that at once.
const MAX_PUBLIC_ZIPS = 3;
let activePublicZips = 0;

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// One response for every failure, so a token reveals nothing about why it doesn't work.
function unavailable() {
  return new Response("This link is invalid, has expired, or the item is no longer available.\n", { status: 404, headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

// Downloads through an unlimited link are counted and recorded once per link and address every ten
// minutes, not for each of the many requests a video player or download manager makes (nor for each
// of a stream of requests meant to flood the activity log). A limited link counts every download.
const RECORD_EVERY_MS = 10 * 60 * 1000;
const recentlyRecorded = new Map<string, number>();

function shouldRecord(key: string, always: boolean) {
  const now = Date.now();
  const last = recentlyRecorded.get(key);
  if (!always && last !== undefined && now - last < RECORD_EVERY_MS) return false;
  recentlyRecorded.delete(key);
  recentlyRecorded.set(key, now);
  if (recentlyRecorded.size > 5_000) recentlyRecorded.delete(recentlyRecorded.keys().next().value!);
  return true;
}

/** Parses a single byte range, including suffix ranges ("bytes=-500" is the last 500 bytes). */
function parseRange(header: string, size: number) {
  const match = /^bytes=(\d{0,20})-(\d{0,20})$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const share = await resolveShareToken((await params).token);
  // An upload link only lets people add files; it never shows or downloads what's there.
  if (!share || isUploadShare(share)) return unavailable();
  if (!isUnlocked(share, request.headers.get("cookie"))) {
    return new Response("This link needs its password. Open the link in a browser to enter it.\n", { status: 401, headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" } });
  }
  // The lock covers only opening the item; counting, auditing, and streaming happen after it.
  const release = await acquireFilesystemLock();
  const opened = await openSharedItem(share).finally(release);
  if (!opened) return unavailable();
  const { handle, openedPath, stat } = opened;
  let streaming = false;
  let zipSlot = false;
  try {
    // A limited link always sends the whole file and counts it, so ranges can't stretch the limit.
    // Unlimited links honour ranges for resuming, counting only requests that start at byte 0.
    // HEAD requests (link previews and scanners) never count.
    const rangeHeader = stat.isFile() && share.maxDownloads === null ? request.headers.get("range") : null;
    const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;
    if (rangeHeader && !range) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${stat.size}` } });
    }
    // A ZIP's slot is taken here, before anything is awaited, so requests arriving together can't all
    // get past the limit; it's given back when the ZIP ends (or below, if it never starts).
    if (stat.isDirectory()) {
      if (activePublicZips >= MAX_PUBLIC_ZIPS) return new Response("The server is busy preparing other downloads. Try again in a minute.\n", { status: 503, headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" } });
      activePublicZips += 1;
      zipSlot = true;
    }
    const limited = share.maxDownloads !== null;
    const address = clientAddress(request);
    if (request.method === "GET" && (!range || range.start === 0) && shouldRecord(`${share.id}|${address}`, limited)) {
      if (!(await recordShareDownload(share.id))) return unavailable();
      await audit("share.download", { id: share.id, path: share.path, address, range: range ? `${range.start}-${range.end}` : undefined });
    }

    if (request.method === "HEAD") {
      return new Response(null, { headers: { ...baseHeaders, "Content-Type": stat.isDirectory() ? "application/zip" : getMime(path.basename(openedPath)), "Content-Disposition": dispositionName(stat.isDirectory() ? `${share.name}.zip` : share.name) } });
    }

    if (stat.isDirectory()) {
      const output = new PassThrough();
      const archive = new ZipArchive({ zlib: { level: 6 } });
      const controller = new AbortController();
      // A visitor who disconnects stops the ZIP and releases every handle it opened.
      const stop = () => {
        controller.abort();
        archive.abort();
        archive.destroy();
      };
      request.signal.addEventListener("abort", stop, { once: true });
      archive.on("error", (error) => output.destroy(error));
      archive.pipe(output);
      zipSlot = false;
      output.once("close", () => {
        activePublicZips -= 1;
        request.signal.removeEventListener("abort", stop);
        if (!output.writableFinished) stop();
      });
      streaming = true;
      void (async () => {
        try {
          archive.append(Buffer.alloc(0), { name: `${share.name}/`, type: "directory", stats: stat });
          // Links inside a shared folder are left out, so their targets are never revealed.
          await appendDirectory(archive, handle, openedPath, share.name, await reservedPathCheck(), controller.signal, false);
          await archive.finalize();
        } catch (error) {
          output.destroy(error as Error);
        }
      })();
      return new Response(Readable.toWeb(output) as ReadableStream, {
        headers: { ...baseHeaders, "Content-Type": "application/zip", "Content-Disposition": dispositionName(`${share.name}.zip`) },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const headers = new Headers({
      ...baseHeaders,
      "Content-Type": getMime(path.basename(openedPath)),
      "Content-Disposition": dispositionName(share.name),
      "Content-Length": String(stat.size === 0 ? 0 : end - start + 1),
      "Accept-Ranges": share.maxDownloads === null ? "bytes" : "none",
    });
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (stat.size === 0) return new Response(null, { status: 200, headers });
    const stream = handle.createReadStream({ start, end });
    streaming = true;
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch {
    return unavailable();
  } finally {
    if (zipSlot) activePublicZips -= 1;
    if (!streaming) await handle.close().catch(() => undefined);
  }
}
