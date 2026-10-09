import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { appendDirectory, reservedPathCheck } from "@/lib/archives";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { appendBundle, bundlePaths, checkBundle, createDownloadTicket, takeDownloadTicket } from "@/lib/bundle-download";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "@/lib/files";
import { AppError, assertMutationRequest, jsonError, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Starts a download of several items as one ZIP: checks them and returns a one-time link. */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const body = await readJsonBody<{ paths?: unknown }>(request, 1024 * 1024);
      const paths = bundlePaths(body.paths);
      await checkBundle(paths);
      const ticket = createDownloadTicket(session.accountKey, paths);
      return Response.json({ url: `/api/fs/download?ticket=${ticket}` }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

function zipResponse(output: PassThrough, name: string) {
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
  const ticket = takeDownloadTicket(token, session.accountKey);
  if (!ticket) throw new AppError("This download link has expired; start the download again", 410, "DOWNLOAD_EXPIRED");
  await audit("fs.download", { username: session.username, paths: ticket.paths.slice(0, 50), items: ticket.paths.length });
  const output = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  // Leaving the page or cancelling the download stops reading files.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  output.once("close", () => abort.abort());
  archive.on("error", (error) => output.destroy(error));
  archive.pipe(output);
  void (async () => {
    try {
      await appendBundle(archive, ticket.paths, abort.signal);
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error as Error);
    }
  })();
  return zipResponse(output, ticket.name);
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
          const output = new PassThrough();
          const archive = new ZipArchive({ zlib: { level: 6 } });
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            void handle.close().catch(() => undefined);
          };
          archive.on("error", (error) => output.destroy(error));
          output.once("close", finish);
          output.once("end", finish);
          archive.pipe(output);
          releaseFilesystem();
          void (async () => {
            try {
              archive.append(Buffer.alloc(0), { name: `${name}/`, type: "directory", stats: stat });
              await appendDirectory(archive, handle, openedPath, name, await reservedPathCheck());
              await archive.finalize();
            } catch (error) {
              output.destroy(error as Error);
            }
          })();
          return zipResponse(output, `${name}.zip`);
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
