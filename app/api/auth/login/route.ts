import { NextResponse } from "next/server";
import {
  assertConfigured,
  checkLoginRateLimit,
  clearLoginFailures,
  clientAddress,
  createSession,
  recordLoginFailure,
  sessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { getCredentials } from "@/lib/credentials";
import { assertMutationRequest, jsonError, AppError } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    assertConfigured();
    const key = clientAddress(request);
    checkLoginRateLimit(key);
    const body = (await request.json()) as { username?: string; password?: string };
    const username = body.username?.trim() || "";
    const password = body.password || "";
    const credentials = await getCredentials();
    const validUser = username === credentials.username;
    const validPassword = await verifyPassword(password, credentials.passwordHash);
    if (!validUser || !validPassword) {
      recordLoginFailure(key);
      await audit("login.failed", { username, client: key });
      throw new AppError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    }

    clearLoginFailures(key);
    const response = NextResponse.json({ authenticated: true, username });
    response.headers.set("Set-Cookie", sessionCookie(createSession(username, credentials.version), request));
    response.headers.set("Cache-Control", "no-store");
    await audit("login.succeeded", { username, client: key });
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
