import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { reservedPathCheck } from "@/lib/archives";
import { requireSession } from "@/lib/auth";
import { acquireFilesystemLock, openVerifiedFile } from "@/lib/files";
import { AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SHA-256 and MD5 of a file in one pass. The lock is held only while opening the file. */
export async function GET(request: Request) {
  try {
    await requireSession(request);
    const isReserved = await reservedPathCheck();
    const unlock = await acquireFilesystemLock();
    let opened: Awaited<ReturnType<typeof openVerifiedFile>>;
    try {
      opened = await openVerifiedFile(new URL(request.url).searchParams.get("path") || "");
    } finally {
      unlock();
    }
    const { handle, openedPath, stat } = opened;
    if (!stat.isFile() || isReserved(openedPath)) {
      await handle.close().catch(() => undefined);
      throw new AppError("Checksums can only be calculated for files", 400, "NOT_A_FILE");
    }
    const sha256 = crypto.createHash("sha256");
    const md5 = crypto.createHash("md5");
    // The read stream owns the handle; closing the dialog aborts the request and stops reading.
    const stream = handle.createReadStream();
    const stop = () => stream.destroy(new AppError("Checksum cancelled", 499, "CANCELLED"));
    request.signal.addEventListener("abort", stop, { once: true });
    let bytes = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        sha256.update(chunk);
        md5.update(chunk);
        bytes += chunk.length;
      }
    } finally {
      request.signal.removeEventListener("abort", stop);
    }
    return NextResponse.json({ sha256: sha256.digest("hex"), md5: md5.digest("hex"), bytes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
