import { NextResponse } from "next/server";
import { config } from "./config";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function jsonError(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error(error);
  return NextResponse.json(
    { error: "Unexpected server error", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}

export async function readJsonBody<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError("Request body must use application/json", 415, "INVALID_CONTENT_TYPE");
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError("Request body is too large", 413, "REQUEST_TOO_LARGE");
  }
  if (!request.body) throw new AppError("Request body is missing", 400, "INVALID_JSON");

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError("Request body is too large", 413, "REQUEST_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as T;
  } catch {
    throw new AppError("Request body contains invalid JSON", 400, "INVALID_JSON");
  }
}

/**
 * For GET endpoints that do real work (thumbnails, checksums): refuse requests another site or
 * origin started, such as an <img> on another port of the same host, which SameSite cookies allow.
 */
export function assertSameOriginFetch(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new AppError("Request verification failed", 403, "CROSS_SITE_REQUEST");
}

export function assertMutationRequest(request: Request) {
  if (request.headers.get("x-filedude-request") !== "1") {
    throw new AppError("Request verification failed", 403, "CSRF_FAILED");
  }

  const origin = request.headers.get("origin");
  const host = config.trustProxy
    ? request.headers.get("x-forwarded-host") || request.headers.get("host")
    : request.headers.get("host");
  const proto = config.trustProxy
    ? request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")
    : new URL(request.url).protocol.replace(":", "");

  if (origin && host) {
    const expected = `${proto}://${host}`;
    if (origin !== expected) {
      throw new AppError("Cross-origin requests are not allowed", 403, "CSRF_FAILED");
    }
  }
}
