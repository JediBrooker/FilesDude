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
import { completeChallenge, createChallenge } from "@/lib/two-factor";
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
    const body = parsed && typeof parsed === "object" ? parsed as { username?: unknown; password?: unknown; challenge?: unknown; code?: unknown } : {};

    // Second step for accounts with two-factor sign-in: the challenge from the password step plus a
    // code. Wrong codes count towards the same sign-in limit as wrong passwords.
    if (body.challenge !== undefined) {
      let completed;
      try {
        completed = await completeChallenge(body.challenge, body.code);
      } catch (error) {
        recordLoginFailure(key);
        await audit("login.two_factor.failed", { client: key, reason: error instanceof AppError ? error.code : "ERROR" });
        throw error;
      }
      clearLoginFailures(key);
      const response = NextResponse.json({ authenticated: true, username: completed.username, recoveryCodesLeft: completed.method === "recovery" ? completed.recoveryCodesLeft : undefined });
      response.headers.set("Set-Cookie", sessionCookie(createSession(completed.username, completed.version, completed.accountKey), request));
      response.headers.set("Cache-Control", "no-store");
      await audit("login.succeeded", { username: completed.username, client: key, twoFactor: completed.method });
      return response;
    }

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const inputValid = username.length > 0 && username.length <= 64 && password.length > 0 && password.length <= 512;
    const credentials = await getCredentials();
    // Every valid attempt reads the account list, so the owner's name doesn't respond faster.
    const found = inputValid ? await findUserByName(username) : undefined;
    const user = username !== credentials.username ? found : undefined;
    const account = !inputValid ? null
      : username === credentials.username ? { key: "owner", username, passwordHash: credentials.passwordHash, hash: credentials.passwordHash, version: credentials.version, twoFactor: credentials.twoFactor }
        : user ? { key: user.id, username, passwordHash: user.passwordHash, hash: user.passwordHash, version: user.version, twoFactor: user.twoFactor } : null;
    // A password check runs even for unknown names, so response timing doesn't reveal which exist.
    const validPassword = await verifyPassword(inputValid ? password : "", account?.hash ?? credentials.passwordHash);
    if (!account || !validPassword) {
      recordLoginFailure(key);
      await audit("login.failed", { username: username.slice(0, 64), client: key });
      throw new AppError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    }

    // The password was right; an account with two-factor sign-in still needs a code before it gets a session.
    if (account.twoFactor) {
      await audit("login.two_factor.challenged", { username, client: key });
      return NextResponse.json({ twoFactorRequired: true, challenge: createChallenge(account) }, { headers: { "Cache-Control": "no-store" } });
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
