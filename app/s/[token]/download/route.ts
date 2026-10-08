import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { appendDirectory, reservedPathCheck } from "@/lib/archives";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/auth";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "@/lib/files";
import { recordShareDownload, resolveShareToken } from "@/lib/shares";

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

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// One response for every failure, so a token reveals nothing about why it doesn't work.
function unavailable() {
  return new Response("This link is invalid, has expired, or the item is no longer available.\n", { status: 404, headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const share = await resolveShareToken((await params).token);
  if (!share) return unavailable();
  const isReserved = await reservedPathCheck();
  const release = await acquireFilesystemLock();
  let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
  try {
    opened = await openVerifiedFile(share.path);
  } catch {
    release();
    return unavailable();
  }
  const { handle, openedPath, stat } = opened;
  try {
    if (isReserved(openedPath) || (stat.isDirectory() ? share.type !== "directory" : !stat.isFile() || share.type !== "file")) {
      throw new Error("Shared item changed type or location");
    }

    // Ranged requests resume a download already counted; only requests from the start count.
    const range = stat.isFile() ? request.headers.get("range") : null;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (range && (!match || start > end || start >= stat.size)) {
      await handle.close();
      release();
      return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${stat.size}` } });
    }
    if (start === 0 && !(await recordShareDownload(share.id))) throw new Error("Link used up");
    await audit("share.download", { id: share.id, path: share.path, address: clientAddress(request), range: range ?? undefined });

    if (stat.isDirectory()) {
      const output = new PassThrough();
      const archive = new ZipArchive({ zlib: { level: 6 } });
      archive.on("error", (error) => output.destroy(error));
      archive.pipe(output);
      release();
      void (async () => {
        try {
          archive.append(Buffer.alloc(0), { name: `${share.name}/`, type: "directory", stats: stat });
          await appendDirectory(archive, handle, openedPath, share.name, isReserved);
          await archive.finalize();
        } catch (error) {
          output.destroy(error as Error);
        }
      })();
      return new Response(Readable.toWeb(output) as ReadableStream, {
        headers: { ...baseHeaders, "Content-Type": "application/zip", "Content-Disposition": dispositionName(`${share.name}.zip`) },
      });
    }

    const stream = handle.createReadStream({ start, end });
    release();
    const headers = new Headers({
      ...baseHeaders,
      "Content-Type": getMime(path.basename(openedPath)),
      "Content-Disposition": dispositionName(share.name),
      "Content-Length": String(Math.max(0, end - start + 1)),
      "Accept-Ranges": "bytes",
    });
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch {
    await handle.close().catch(() => undefined);
    release();
    return unavailable();
  }
}
