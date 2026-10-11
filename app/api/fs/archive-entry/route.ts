import type { Readable } from "node:stream";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { readArchiveEntry } from "@/lib/archive-browse";
import { getMime } from "@/lib/files";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each account reads a few files from archives at once (a tar is read up to the file).
const MAX_ACTIVE_PER_ACCOUNT = 3;
const active = new Map<string, number>();

// Files from archives are shown in the page only as these kinds; text of any sort is sent as plain
// text (never as HTML or a script), and anything else is only downloaded.
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac", "audio/wav", "video/mp4", "video/webm"]);
const TEXT = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|x-httpd-php)|image\/svg)/;

function contentType(name: string) {
  const mime = getMime(name);
  if (INLINE.has(mime)) return { type: mime, inline: true };
  if (TEXT.test(mime)) return { type: "text/plain; charset=utf-8", inline: true };
  return { type: "application/octet-stream", inline: false };
}

/**
 * The file's contents as a web stream, read only as fast as they're sent; the reader going away
 * stops it (unlike Readable.toWeb, which can throw if more arrives after it has gone).
 */
function webStream(stream: Readable) {
  stream.pause();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) stream.pause();
        } catch {
          stream.destroy();
        }
      });
      stream.on("end", () => { try { controller.close(); } catch { /* already gone */ } });
      stream.on("error", (error) => { try { controller.error(error); } catch { /* already gone */ } });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
    },
  });
}

/** A filename for Content-Disposition: plain ASCII, with the real name encoded beside it. */
function disposition(kind: "inline" | "attachment", name: string) {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** One file from inside an archive: ?path= (the archive), entry= (inside it), download=1. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async (session) => {
      const account = session.accountKey;
      if ((active.get(account) ?? 0) >= MAX_ACTIVE_PER_ACCOUNT) throw new AppError("Other files are still being read from archives; try again shortly", 503, "ARCHIVE_BUSY");
      active.set(account, (active.get(account) ?? 0) + 1);
      let release: (() => void) | null = () => {
        const left = (active.get(account) ?? 1) - 1;
        if (left > 0) active.set(account, left);
        else active.delete(account);
      };
      const done = () => {
        release?.();
        release = null;
      };
      try {
        const params = new URL(request.url).searchParams;
        const archive = params.get("path") ?? "";
        const entry = params.get("entry") ?? "";
        if (archive.length > 4096 || entry.length > 4096) throw new AppError("Path is invalid", 400, "INVALID_PATH");
        const download = params.get("download") === "1";
        const { name, size, stream } = await readArchiveEntry(archive, entry, request.signal);
        stream.on("close", done);
        const { type, inline } = contentType(name);
        if (download) await audit("fs.download", { username: session.username, path: archive, entry });
        return new Response(webStream(stream), {
          headers: {
            "Content-Type": download ? "application/octet-stream" : type,
            "Content-Length": String(size),
            "Content-Disposition": disposition(download || !inline ? "attachment" : "inline", name),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        });
      } catch (error) {
        done();
        throw error;
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
