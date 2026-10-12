import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { clientAddress, createSession, reissueSession, sessionCookie, setStaySignedIn, signOutEverywhere, STAY_SIGNED_IN_DAYS, verifyCurrentPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { confirmWithCode, findAccount } from "@/lib/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the signed-in account stays signed in, and when this device signed in and is signed out. */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      const account = await findAccount(session.accountKey);
      if (!account) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
      return NextResponse.json({
        staySignedIn: account.staySignedIn,
        // Turning it on asks for a code too.
        twoFactor: Boolean(account.twoFactor),
        thisDevice: { staysSignedIn: session.staySignedIn, signedInAt: new Date(session.signedInAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString() },
        days: STAY_SIGNED_IN_DAYS,
        hours: config.sessionHours,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

type SessionBody = { action?: unknown; staySignedIn?: unknown; currentPassword?: unknown; code?: unknown };

/**
 * Every account chooses for itself whether it stays signed in. Turning it on keeps this device
 * signed in from now, and others from their next sign-in; turning it off signs out the account's
 * other devices and gives this one a fresh FILEDUDE_SESSION_HOURS. "signOutOthers" signs out every
 * other device, for a lost phone or a computer that isn't yours.
 *
 * Each needs the current password, so a session left open (or a copied cookie) can neither make
 * itself last for weeks nor keep signing its owner out; turning it on also needs a two-factor code
 * when that's on, as it weakens sign-in as much as turning that off would.
 */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 4 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as SessionBody;
      const account = await findAccount(session.accountKey);
      if (!account) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
      const withSession = (token?: string) => {
        const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        if (token) response.headers.set("Set-Cookie", sessionCookie(token, request));
        return response;
      };

      const turningOn = body.action === "stay" && body.staySignedIn === true;
      if (body.action !== "signOutOthers" && (body.action !== "stay" || typeof body.staySignedIn !== "boolean")) throw new AppError("Unknown sign-in operation", 400, "UNKNOWN_ACTION");
      const client = clientAddress(request);
      const failed = async (reason: string) => audit("settings.stay_signed_in.failed", { username: session.username, client, action: turningOn ? "on" : body.action === "signOutOthers" ? "signOutOthers" : "off", reason });
      if (!(await verifyCurrentPassword(session, body.currentPassword, account.passwordHash))) {
        await failed("INVALID_CURRENT_PASSWORD");
        throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
      }

      if (body.action === "signOutOthers") {
        const { version } = await signOutEverywhere(session);
        await audit("logout.others", { username: session.username, client });
        return withSession(reissueSession(session, version));
      }

      if (turningOn) {
        if (account.twoFactor) {
          if (body.code === undefined || body.code === "") throw new AppError("Enter a code from your authenticator app to stay signed in", 400, "CODE_REQUIRED");
          try {
            await confirmWithCode(account.key, body.code);
          } catch (error) {
            if (error instanceof AppError && (error.code === "INVALID_TWO_FACTOR_CODE" || error.code === "TWO_FACTOR_LOCKED")) await failed(error.code);
            throw error;
          }
        }
        const { username, version, changed } = await setStaySignedIn(session, true);
        // Already on for the account: this only keeps this device signed in too.
        await audit("settings.stay_signed_in", { username, on: true, thisDeviceOnly: changed ? undefined : true, client });
        return withSession(createSession(username, version, account.key, { staySignedIn: true, signedInAt: session.signedInAt }));
      }
      const { username, version, changed } = await setStaySignedIn(session, false);
      if (!changed) return withSession();
      await audit("settings.stay_signed_in", { username, on: false, client });
      return withSession(createSession(username, version, account.key));
    });
  } catch (error) {
    return jsonError(error);
  }
}
