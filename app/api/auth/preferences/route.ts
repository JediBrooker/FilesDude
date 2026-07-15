import { NextResponse } from "next/server";
import { createSession, requireSession, sessionCookie, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getCredentials, hashPassword, saveCredentials, validateNewPassword, validateUsername } from "@/lib/credentials";
import { identityCatalog, isKnownIdentityPair } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";
import { getPreferences, parseUploadOwnershipPreference, savePreferences } from "@/lib/preferences";
import type { UploadOwnershipPreference } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const [preferences, identities] = await Promise.all([getPreferences(), identityCatalog()]);
    return NextResponse.json({
      username: session.username,
      uploadOwnership: preferences.uploadOwnership,
      identities,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const body = (await request.json()) as { currentPassword?: string; username?: string; newPassword?: string; uploadOwnership?: UploadOwnershipPreference };
    const [current, storedPreferences] = await Promise.all([getCredentials(), getPreferences()]);
    const username = validateUsername(body.username || current.username);
    const passwordChanged = Boolean(body.newPassword);
    const credentialsChanged = username !== current.username || passwordChanged;
    const uploadOwnership = body.uploadOwnership === undefined
      ? storedPreferences.uploadOwnership
      : parseUploadOwnershipPreference(body.uploadOwnership);
    const ownershipChanged = JSON.stringify(uploadOwnership) !== JSON.stringify(storedPreferences.uploadOwnership);

    if (credentialsChanged) {
      if (!body.currentPassword) throw new AppError("Current password is required to change sign-in details", 400, "CURRENT_PASSWORD_REQUIRED");
      if (!(await verifyPassword(body.currentPassword, current.passwordHash))) {
        await audit("settings.credentials.failed", { username: session.username });
        throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
      }
      if (body.newPassword) validateNewPassword(body.newPassword);
    }

    if (ownershipChanged && uploadOwnership.mode === "fixed" && !(await isKnownIdentityPair(uploadOwnership.uid, uploadOwnership.gid))) {
      throw new AppError("Choose an owner and group available on this server", 400, "INVALID_UPLOAD_OWNERSHIP");
    }
    if (!credentialsChanged && !ownershipChanged) throw new AppError("No preference changes to save", 400, "NO_CHANGES");

    const updatedAt = new Date().toISOString();
    let credentialVersion = current.version;
    if (credentialsChanged) {
      const updated = {
        username,
        passwordHash: body.newPassword ? await hashPassword(body.newPassword) : current.passwordHash,
        version: current.version + 1,
        updatedAt,
      };
      await saveCredentials(updated);
      credentialVersion = updated.version;
    }
    if (ownershipChanged) await savePreferences({ uploadOwnership, updatedAt });
    await audit("settings.preferences.updated", {
      previousUsername: current.username,
      username,
      passwordChanged,
      uploadOwnership: ownershipChanged ? uploadOwnership : undefined,
    });

    const response = NextResponse.json({ ok: true, username, uploadOwnership });
    if (credentialsChanged) response.headers.set("Set-Cookie", sessionCookie(createSession(username, credentialVersion), request));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
