import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { verifyCurrentPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { beginRegistration, finishRegistration, listPasskeys, relyingParty, removePasskey, renamePasskey } from "@/lib/passkeys";
import { confirmWithCode, findAccount } from "@/lib/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in account's passkeys. */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => NextResponse.json({ passkeys: await listPasskeys(session.accountKey) }, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

type PasskeysBody = { action?: unknown; currentPassword?: unknown; code?: unknown; response?: unknown; id?: unknown; name?: unknown };

/**
 * Every account manages its own passkeys. Adding one needs the current password (and a code, with
 * two-factor sign-in on), since a passkey signs in on its own: a session left open mustn't be able
 * to add a way back in. Renaming and removing one only needs the session.
 */
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 64 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as PasskeysBody;
      const account = await findAccount(session.accountKey);
      if (!account) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
      const noStore = { headers: { "Cache-Control": "no-store" } };
      switch (body.action) {
        case "options": {
          const party = relyingParty(request);
          if (!(await verifyCurrentPassword(session, body.currentPassword, account.passwordHash))) {
            await audit("settings.passkey.failed", { username: session.username, reason: "INVALID_CURRENT_PASSWORD" });
            throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
          }
          if (account.twoFactor) {
            try {
              await confirmWithCode(account.key, body.code);
            } catch (error) {
              if (error instanceof AppError) await audit("settings.passkey.failed", { username: session.username, reason: error.code });
              throw error;
            }
          }
          return NextResponse.json({ options: await beginRegistration(account, party) }, noStore);
        }
        case "register": {
          const passkey = await finishRegistration(account, relyingParty(request), body.response, body.name);
          await audit("settings.passkey.added", { username: session.username, passkey: passkey.name, rpId: passkey.rpId });
          return NextResponse.json({ ok: true, passkey, passkeys: await listPasskeys(account.key) }, noStore);
        }
        case "rename": {
          const { previousName, passkey } = await renamePasskey(account.key, body.id, body.name);
          if (previousName !== passkey.name) await audit("settings.passkey.renamed", { username: session.username, from: previousName, passkey: passkey.name, rpId: passkey.rpId });
          return NextResponse.json({ ok: true, passkey, passkeys: await listPasskeys(account.key) }, noStore);
        }
        case "remove": {
          const passkey = await removePasskey(account.key, body.id);
          await audit("settings.passkey.removed", { username: session.username, passkey: passkey.name, rpId: passkey.rpId });
          return NextResponse.json({ ok: true, passkeys: await listPasskeys(account.key) }, noStore);
        }
        default:
          throw new AppError("Unknown passkey operation", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
