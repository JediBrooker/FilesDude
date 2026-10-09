import { constants } from "node:fs";
import fs from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { appendDirectory, reservedPathCheck } from "@/lib/archives";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getMime } from "@/lib/files";
import { AppError, jsonError } from "@/lib/http";
import { snapshotItem } from "@/lib/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dispositionName(name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Downloads a file (or a folder as a ZIP) as it was in a snapshot. Snapshots can't change, so no lock is needed. */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      const url = new URL(request.url);
      const item = await snapshotItem(url.searchParams.get("snapshot") || "", url.searchParams.get("path") || "");
      if (!item.relative) throw new AppError("Choose an item inside the snapshot", 400, "INVALID_REQUEST");
      const directory = item.stat.isDirectory();
      if (!directory && !item.stat.isFile()) throw new AppError("Only files and folders can be downloaded", 400, "UNSUPPORTED_FILE_TYPE");
      const handle = await fs.open(item.location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
      try {
        const stat = await handle.stat();
        await audit("snapshots.download", { username: session.username, snapshot: item.snapshot.name, path: item.relative });
        if (directory) {
          const output = new PassThrough();
          const archive = new ZipArchive({ zlib: { level: 6 } });
          const finish = () => void handle.close().catch(() => undefined);
          archive.on("error", (error) => output.destroy(error));
          output.once("close", finish);
          archive.pipe(output);
          void (async () => {
            try {
              archive.append(Buffer.alloc(0), { name: `${item.name}/`, type: "directory", stats: stat });
              await appendDirectory(archive, handle, item.location, item.name, await reservedPathCheck());
              await archive.finalize();
            } catch (error) {
              output.destroy(error as Error);
            }
          })();
          return new Response(Readable.toWeb(output) as ReadableStream, {
            headers: { "Content-Type": "application/zip", "Content-Disposition": dispositionName(`${item.name}.zip`), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
          });
        }
        if (!stat.isFile()) throw new AppError("Only files and folders can be downloaded", 400, "UNSUPPORTED_FILE_TYPE");
        return new Response(Readable.toWeb(handle.createReadStream()) as ReadableStream, {
          headers: { "Content-Type": getMime(item.name), "Content-Length": String(stat.size), "Content-Disposition": dispositionName(item.name), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
