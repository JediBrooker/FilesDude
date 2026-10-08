import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { reservedPathCheck } from "@/lib/archives";
import { requireSession } from "@/lib/auth";
import { acquireFilesystemLock, openVerifiedFile } from "@/lib/files";
import { AppError, assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hashing runs on the main thread; two at a time is plenty for one administrator.
const MAX_ACTIVE_CHECKSUMS = 2;
let activeChecksums = 0;

/** SHA-256 and MD5 of a file in one pass. The lock is held only while opening the file. */
export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    await requireSession(request);
    if (activeChecksums >= MAX_ACTIVE_CHECKSUMS) throw new AppError("Other checksums are still being calculated; try again shortly", 503, "CHECKSUMS_BUSY");
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
    let bytes = 0;
    activeChecksums += 1;
    try {
      if (stat.size > 0 && !request.signal.aborted) {
        // Only the size measured at open is read, so a file growing meanwhile can't keep this going.
        // The read stream owns the handle; closing the dialog aborts the request and stops reading.
        const stream = handle.createReadStream({ start: 0, end: stat.size - 1 });
        const stop = () => stream.destroy(new AppError("Checksum cancelled", 499, "CANCELLED"));
        request.signal.addEventListener("abort", stop, { once: true });
        try {
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            sha256.update(chunk);
            md5.update(chunk);
            bytes += chunk.length;
          }
        } finally {
          request.signal.removeEventListener("abort", stop);
        }
      } else {
        await handle.close().catch(() => undefined);
      }
    } finally {
      activeChecksums -= 1;
    }
    return NextResponse.json({ sha256: sha256.digest("hex"), md5: md5.digest("hex"), bytes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
