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

  const message = error instanceof Error ? error.message : "Unexpected server error";
  console.error(error);
  return NextResponse.json(
    { error: message, code: "INTERNAL_ERROR" },
    { status: 500 },
  );
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
