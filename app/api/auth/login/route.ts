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
import { findUserByName } from "@/lib/users";
import { assertMutationRequest, jsonError, AppError, readJsonBody } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    assertConfigured();
    const key = clientAddress(request);
    checkLoginRateLimit(key);
    const parsed = await readJsonBody<unknown>(request, 8 * 1024);
    const body = parsed && typeof parsed === "object" ? parsed as { username?: unknown; password?: unknown } : {};
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const inputValid = username.length > 0 && username.length <= 64 && password.length > 0 && password.length <= 512;
    const credentials = await getCredentials();
    const user = inputValid && username !== credentials.username ? await findUserByName(username) : undefined;
    const account = !inputValid ? null
      : username === credentials.username ? { key: "owner", hash: credentials.passwordHash, version: credentials.version }
        : user ? { key: user.id, hash: user.passwordHash, version: user.version } : null;
    // A password check runs even for unknown names, so response timing doesn't reveal which exist.
    const validPassword = await verifyPassword(inputValid ? password : "", account?.hash ?? credentials.passwordHash);
    if (!account || !validPassword) {
      recordLoginFailure(key);
      await audit("login.failed", { username: username.slice(0, 64), client: key });
      throw new AppError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    }

    clearLoginFailures(key);
    const response = NextResponse.json({ authenticated: true, username });
    response.headers.set("Set-Cookie", sessionCookie(createSession(username, account.version, account.key), request));
    response.headers.set("Cache-Control", "no-store");
    await audit("login.succeeded", { username, client: key });
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
