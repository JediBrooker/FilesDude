import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getMime, safeResolve } from "@/lib/files";
import { jsonError } from "@/lib/http";

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
    const absolute = await safeResolve(relativePath);
    const stat = await fsp.stat(absolute);
    const name = path.basename(absolute) || "files";
    await audit("fs.download", { username: session.username, path: relativePath });

    if (stat.isDirectory()) {
      const output = new PassThrough();
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (error) => output.destroy(error));
      archive.pipe(output);
      archive.directory(absolute, name);
      void archive.finalize();
      return new Response(Readable.toWeb(output) as ReadableStream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": dispositionName(`${name}.zip`),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(absolute)) as ReadableStream, {
      headers: {
        "Content-Type": getMime(absolute),
        "Content-Length": String(stat.size),
        "Content-Disposition": dispositionName(name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
