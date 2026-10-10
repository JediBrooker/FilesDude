import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { createSession, sessionCookie, verifyCurrentPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { beginSetup, disableTwoFactor, findAccount, finishSetup, regenerateRecoveryCodes, twoFactorStatus } from "@/lib/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the signed-in account uses two-factor sign-in, and how many recovery codes it has left. */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => NextResponse.json(await twoFactorStatus(session.accountKey), { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

type TwoFactorBody = { action?: unknown; currentPassword?: unknown; setupToken?: unknown; code?: unknown };

/**
 * Every account manages its own two-factor sign-in. Starting setup, turning it off, and replacing
 * recovery codes need the current password, so a session left open can't lock its owner out or
 * quietly take over the second factor. Turning it on or off signs out the account's other sessions.
 */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 16 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as TwoFactorBody;
      const account = await findAccount(session.accountKey);
      if (!account) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
      const requirePassword = async () => {
        if (!(await verifyCurrentPassword(account.key, body.currentPassword, account.passwordHash))) {
          await audit("settings.two_factor.failed", { username: session.username, action: body.action });
          throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
        }
      };
      const auditWrongCode = async <T,>(check: () => Promise<T>) => {
        try {
          return await check();
        } catch (error) {
          if (error instanceof AppError && (error.code === "INVALID_TWO_FACTOR_CODE" || error.code === "TWO_FACTOR_LOCKED")) {
            await audit("settings.two_factor.failed", { username: session.username, action: body.action, reason: error.code });
          }
          throw error;
        }
      };
      const withNewSession = (payload: Record<string, unknown>, version: number) => {
        const response = NextResponse.json({ ok: true, ...payload }, { headers: { "Cache-Control": "no-store" } });
        response.headers.set("Set-Cookie", sessionCookie(createSession(account.username, version, account.key), request));
        return response;
      };
      switch (body.action) {
        case "setup":
          await requirePassword();
          return NextResponse.json(await beginSetup(account), { headers: { "Cache-Control": "no-store" } });
        case "enable": {
          const { result: recoveryCodes, version } = await finishSetup(account.key, body.setupToken, body.code);
          await audit("settings.two_factor.enabled", { username: session.username });
          return withNewSession({ recoveryCodes }, version);
        }
        case "disable": {
          await requirePassword();
          const { version } = await auditWrongCode(() => disableTwoFactor(account.key, body.code));
          await audit("settings.two_factor.disabled", { username: session.username });
          return withNewSession({}, version);
        }
        case "recovery-codes": {
          await requirePassword();
          const { result: recoveryCodes, version } = await auditWrongCode(() => regenerateRecoveryCodes(account.key, body.code));
          await audit("settings.two_factor.recovery_codes", { username: session.username });
          return withNewSession({ recoveryCodes }, version);
        }
        default:
          throw new AppError("Unknown two-factor operation", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
