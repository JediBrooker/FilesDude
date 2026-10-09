import path from "node:path";
import { Readable, Transform } from "node:stream";
import { ZipArchive, type Archiver } from "archiver";
import { appendDirectory, archiveEntryName, reservedPathCheck } from "@/lib/archives";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { appendBundle, bundlePaths, checkBundle, createDownloadTicket, takeDownloadTicket } from "@/lib/bundle-download";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "@/lib/files";
import { AppError, assertMutationRequest, jsonError, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Encoded as RFC 8187 asks (which encodeURIComponent alone doesn't quite do), and never throws: a
// name that isn't well-formed Unicode is repaired first.
function dispositionName(name: string) {
  const wellFormed = name.toWellFormed();
  const ascii = wellFormed.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(wellFormed).replace(/['()*!]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ZIPs are built while they download, holding files open and using compression threads, so each
// account has at most two going (and the server eight), and one nobody is reading is stopped.
const MAX_ZIPS_PER_ACCOUNT = 2;
const MAX_ZIPS = 8;
const ZIP_IDLE_MS = 60_000;
const activeZips = new Map<string, number>();
let totalZips = 0;

function reserveZip(account: string) {
  if (totalZips >= MAX_ZIPS || (activeZips.get(account) ?? 0) >= MAX_ZIPS_PER_ACCOUNT) throw new AppError("Other ZIP downloads are still running; try again when they finish", 503, "ZIPS_BUSY");
  totalZips += 1;
  activeZips.set(account, (activeZips.get(account) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalZips -= 1;
    const remaining = (activeZips.get(account) ?? 1) - 1;
    if (remaining > 0) activeZips.set(account, remaining);
    else activeZips.delete(account);
  };
}

// Checking a selection opens every item, so each account checks at most two at once.
const MAX_CHECKS_PER_ACCOUNT = 2;
const activeChecks = new Map<string, number>();

/** Starts a download of several items as one ZIP: checks them and returns a one-time link. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const account = session.accountKey;
      if ((activeChecks.get(account) ?? 0) >= MAX_CHECKS_PER_ACCOUNT) throw new AppError("Other downloads are still being prepared; try again shortly", 503, "DOWNLOADS_BUSY");
      activeChecks.set(account, (activeChecks.get(account) ?? 0) + 1);
      try {
        const body = await readJsonBody<{ paths?: unknown }>(request, 1024 * 1024);
        const paths = bundlePaths(body.paths);
        await checkBundle(paths);
        const ticket = createDownloadTicket(account, paths);
        return Response.json({ url: `/api/fs/download?ticket=${ticket}` }, { headers: { "Cache-Control": "no-store" } });
      } finally {
        const remaining = (activeChecks.get(account) ?? 1) - 1;
        if (remaining > 0) activeChecks.set(account, remaining);
        else activeChecks.delete(account);
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Streams a ZIP that `work` fills. The response is built before any work starts, so nothing runs
 * unless it is being sent; leaving the download, finishing, or a minute without the client reading
 * stops the work and frees its slot.
 */
function zipDownload(request: Request, account: string, name: string, work: (archive: Archiver, signal: AbortSignal) => Promise<void>) {
  const release = reserveZip(account);
  let lastRead = Date.now();
  // Data passes through only as fast as the client reads it, so a stall here means nobody is reading.
  const output = new Transform({ transform(chunk, _encoding, done) { lastRead = Date.now(); done(null, chunk); } });
  const abort = new AbortController();
  const watchdog = setInterval(() => { if (Date.now() - lastRead > ZIP_IDLE_MS) output.destroy(); }, 10_000);
  const stop = () => {
    clearInterval(watchdog);
    abort.abort();
    release();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  output.once("close", stop);
  let response: Response;
  try {
    response = zipResponse(output, name);
  } catch (error) {
    output.destroy();
    throw error;
  }
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (error) => output.destroy(error));
  archive.pipe(output);
  void (async () => {
    try {
      await work(archive, abort.signal);
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error as Error);
    }
  })().catch(() => undefined);
  return response;
}

function zipResponse(output: Transform, name: string) {
  return new Response(Readable.toWeb(output) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": dispositionName(name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// The ZIP of several items, for a ticket made by POST for this account.
async function bundleDownload(request: Request, token: string, session: { accountKey: string; username: string }) {
  // HEAD requests (download managers probing) reach here too, and mustn't use the ticket up.
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const ticket = takeDownloadTicket(token, session.accountKey);
  if (!ticket) throw new AppError("This download link has expired; start the download again", 410, "DOWNLOAD_EXPIRED");
  await audit("fs.download", { username: session.username, paths: ticket.paths.slice(0, 50), items: ticket.paths.length });
  return zipDownload(request, session.accountKey, ticket.name, (archive, signal) => appendBundle(archive, ticket.paths, signal));
}

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
    const token = new URL(request.url).searchParams.get("ticket");
    if (token) return bundleDownload(request, token, session);
    const relativePath = new URL(request.url).searchParams.get("path") || "";
    const releaseFilesystem = await acquireFilesystemLock();
    try {
      const { absolute, handle, openedPath, stat } = await openVerifiedFile(relativePath);
      try {
        const name = path.basename(absolute) || "files";
        await audit("fs.download", { username: session.username, path: relativePath });

        if (stat.isDirectory()) {
          const isReserved = await reservedPathCheck();
          const entryName = archiveEntryName(name);
          // The work takes over the handle (appendDirectory closes it); until then it is ours to close.
          const response = zipDownload(request, session.accountKey, `${name}.zip`, async (archive, signal) => {
            archive.append(Buffer.alloc(0), { name: `${entryName}/`, type: "directory", stats: stat });
            await appendDirectory(archive, handle, openedPath, entryName, isReserved, signal);
          });
          releaseFilesystem();
          return response;
        }

        if (!stat.isFile()) throw new AppError("Only files and folders can be downloaded", 400, "UNSUPPORTED_FILE_TYPE");
        const stream = handle.createReadStream();
        releaseFilesystem();
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          headers: {
            "Content-Type": getMime(absolute),
            "Content-Length": String(stat.size),
            "Content-Disposition": dispositionName(name),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      releaseFilesystem();
      throw error;
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
