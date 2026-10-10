import { NextResponse } from "next/server";
import { assertConfigured, assertLoginAllowed, checkLoginRateLimit, clientAddress, createSession, refundLoginAttempt, sessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { beginSignIn, finishSignIn, relyingParty } from "@/lib/passkeys";
import { findAccount } from "@/lib/two-factor";

export const runtime = "nodejs";

/**
 * Signing in with a passkey: "options" gives the browser a challenge, and "verify" checks what the
 * passkey signed and starts a session. A passkey proves both the device and the person (its PIN or
 * biometric), so it doesn't also need a two-factor code. Failed tries count towards the same
 * sign-in limit as passwords.
 */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    assertConfigured();
    const key = clientAddress(request);
    const parsed = await readJsonBody<unknown>(request, 64 * 1024);
    const body = parsed && typeof parsed === "object" ? parsed as { action?: unknown; challengeId?: unknown; response?: unknown } : {};
    const party = relyingParty(request);

    if (body.action === "options") {
      // Asking for a challenge isn't a try (nor kept track of), but isn't allowed while the address is locked out.
      assertLoginAllowed(key);
      return NextResponse.json(await beginSignIn(party), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action !== "verify") throw new AppError("Unknown sign-in operation", 400, "UNKNOWN_ACTION");

    checkLoginRateLimit(key);
    let signedIn;
    try {
      const { accountKey, passkey } = await finishSignIn(party, body.challengeId, body.response);
      const account = await findAccount(accountKey);
      if (!account) throw new AppError("That passkey wasn't recognised. It may have been removed, or added on a different address.", 401, "PASSKEY_INVALID");
      signedIn = { account, passkey };
    } catch (error) {
      await audit("login.failed", { client: key, method: "passkey", reason: error instanceof AppError ? error.code : "ERROR" });
      throw error;
    }
    const { account, passkey } = signedIn;
    refundLoginAttempt(key);
    const response = NextResponse.json({ authenticated: true, username: account.username });
    response.headers.set("Set-Cookie", sessionCookie(createSession(account.username, account.version, account.key), request));
    response.headers.set("Cache-Control", "no-store");
    await audit("login.succeeded", { username: account.username, client: key, method: "passkey", passkey: passkey.name });
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
