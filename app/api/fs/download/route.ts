import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { appendDirectory } from "@/lib/archives";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { acquireFilesystemLock, getMime, openVerifiedFile } from "@/lib/files";
import { AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
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
              const stateDirectory = await fsp.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
              archive.append(Buffer.alloc(0), { name: `${name}/`, type: "directory", stats: stat });
              await appendDirectory(archive, handle, openedPath, name, (opened) => opened === stateDirectory || opened.startsWith(`${stateDirectory}${path.sep}`));
              await archive.finalize();
            } catch (error) {
              output.destroy(error as Error);
            }
          })();
          return new Response(Readable.toWeb(output) as ReadableStream, {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": dispositionName(`${name}.zip`),
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
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
  } catch (error) {
    return jsonError(error);
  }
}
