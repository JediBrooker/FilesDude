import { constants, type Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Readable as NodeReadable } from "node:stream";
import { ZipArchive } from "archiver";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { acquireFilesystemLock, getMime, openVerifiedFile, verifyFileHandleWithinRoot } from "@/lib/files";
import { AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function appendFileAndWait(archive: ZipArchive, stream: NodeReadable, name: string, stats: Stats) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off("error", onError);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); resolve(); };
    archive.once("error", onError);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      archive.append(stream, { name, stats });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function appendDirectory(archive: ZipArchive, handle: FileHandle, openedPath: string, archivePath: string, stateDirectory: string) {
  const directoryPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : openedPath;
  let directory;
  try {
    directory = await fsp.opendir(directoryPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  try {
    for await (const entry of directory) {
      if (entry.name === ".filedude") continue;
      const childPath = path.join(directoryPath, entry.name);
      const childArchivePath = path.posix.join(archivePath, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          archive.symlink(childArchivePath, await fsp.readlink(childPath));
        } catch {
          // The entry changed while the archive was being created; omit it.
        }
        continue;
      }

      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (entry.isDirectory() ? constants.O_DIRECTORY : 0);
      let childHandle: FileHandle | null = null;
      try {
        childHandle = await fsp.open(childPath, flags);
      } catch {
        continue;
      }

      try {
        const verified = await verifyFileHandleWithinRoot(childHandle, path.join(openedPath, entry.name));
        if (verified.openedPath === stateDirectory || verified.openedPath.startsWith(`${stateDirectory}${path.sep}`)) continue;
        if (verified.stat.isDirectory()) {
          archive.append(Buffer.alloc(0), { name: `${childArchivePath}/`, type: "directory", stats: verified.stat });
          await appendDirectory(archive, childHandle, verified.openedPath, childArchivePath, stateDirectory);
          childHandle = null;
        } else if (verified.stat.isFile()) {
          const stream = childHandle.createReadStream();
          await appendFileAndWait(archive, stream, childArchivePath, verified.stat);
          childHandle = null;
        }
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
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
              await appendDirectory(archive, handle, openedPath, name, stateDirectory);
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
