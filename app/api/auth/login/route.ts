import { NextResponse } from "next/server";
import {
  assertConfigured,
  checkLoginRateLimit,
  checkUsernameRateLimit,
  clientAddress,
  createSession,
  refundLoginAttempt,
  refundUsernameAttempt,
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
    // code. Each try counts towards the same sign-in limit as passwords (counted when it started).
    if (body.challenge !== undefined) {
      let completed;
      try {
        completed = await completeChallenge(body.challenge, body.code);
      } catch (error) {
        await audit("login.two_factor.failed", { client: key, reason: error instanceof AppError ? error.code : "ERROR" });
        throw error;
      }
      refundLoginAttempt(key);
      const response = NextResponse.json({ authenticated: true, username: completed.username, recoveryCodesLeft: completed.method === "recovery" ? completed.recoveryCodesLeft : undefined });
      response.headers.set("Set-Cookie", sessionCookie(createSession(completed.username, completed.version, completed.accountKey), request));
      response.headers.set("Cache-Control", "no-store");
      await audit("login.succeeded", { username: completed.username, client: key, twoFactor: completed.method });
      return response;
    }

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const inputValid = username.length > 0 && username.length <= 64 && password.length > 0 && password.length <= 512;
    // Tries at one username are limited too, whichever addresses they come from.
    if (inputValid) {
      try {
        checkUsernameRateLimit(username);
      } catch (error) {
        refundLoginAttempt(key);
        throw error;
      }
    }
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
      // An unknown name isn't recorded: it's often a password typed into the wrong box.
      await audit("login.failed", { username: account ? username : undefined, unknownUsername: account ? undefined : true, client: key });
      throw new AppError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    }

    // The password was right; an account with two-factor sign-in still needs a code before it gets a session.
    if (account.twoFactor) {
      // A right password isn't a failed attempt; the code step counts its own tries.
      refundLoginAttempt(key);
      refundUsernameAttempt(username);
      await audit("login.two_factor.challenged", { username, client: key });
      return NextResponse.json({ twoFactorRequired: true, challenge: createChallenge(account) }, { headers: { "Cache-Control": "no-store" } });
    }
    refundLoginAttempt(key);
    refundUsernameAttempt(username);
    const response = NextResponse.json({ authenticated: true, username });
    response.headers.set("Set-Cookie", sessionCookie(createSession(username, account.version, account.key), request));
    response.headers.set("Cache-Control", "no-store");
    await audit("login.succeeded", { username, client: key });
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
