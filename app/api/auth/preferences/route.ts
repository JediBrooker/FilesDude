import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { createSession, sessionCookie, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getCredentials, hashPassword, updateCredentials, validateNewPassword, validateUsername } from "@/lib/credentials";
import { identityCatalog, isKnownIdentityPair } from "@/lib/files";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { getPreferences, parseTrashRetention, parseUploadOwnershipPreference, savePreferences } from "@/lib/preferences";
import { runTrashRetention } from "@/lib/trash-retention";
import type { UploadOwnershipPreference } from "@/lib/types";
import { changeOwnPassword, findUserById, isUserUsername } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "read", async (session) => {
      // Server-wide settings and the list of system users are only for the owner.
      if (session.role !== "owner") return NextResponse.json({ username: session.username, role: session.role, root: session.root }, { headers: { "Cache-Control": "no-store" } });
      const [preferences, identities] = await Promise.all([getPreferences(), identityCatalog()]);
      return NextResponse.json({
        username: session.username,
        role: session.role,
        root: session.root,
        uploadOwnership: preferences.uploadOwnership,
        trashRetentionDays: preferences.trashRetentionDays,
        uploadInPieces: preferences.uploadInPieces,
        identities,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "read", async (session) => {
    const parsed = await readJsonBody<unknown>(request, 16 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
    const body = parsed as { currentPassword?: unknown; username?: unknown; newPassword?: unknown; uploadOwnership?: UploadOwnershipPreference; trashRetentionDays?: unknown; uploadInPieces?: unknown };
    if (body.currentPassword !== undefined && typeof body.currentPassword !== "string") throw new AppError("Current password is invalid", 400, "INVALID_REQUEST");
    if (body.username !== undefined && typeof body.username !== "string") throw new AppError("Username is invalid", 400, "INVALID_REQUEST");
    if (body.newPassword !== undefined && typeof body.newPassword !== "string") throw new AppError("New password is invalid", 400, "INVALID_REQUEST");

    // Editors and viewers can only change their own password; the owner manages everything else.
    if (session.role !== "owner") {
      if (body.username !== undefined || body.uploadOwnership !== undefined || body.trashRetentionDays !== undefined || body.uploadInPieces !== undefined) throw new AppError("Only the owner account can change that", 403, "FORBIDDEN");
      if (!body.newPassword) throw new AppError("No preference changes to save", 400, "NO_CHANGES");
      const user = await findUserById(session.accountKey);
      if (!user) throw new AppError("Sign in required", 401, "UNAUTHORIZED");
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword as string, user.passwordHash))) {
        await audit("settings.credentials.failed", { username: session.username });
        throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
      }
      const version = await changeOwnPassword(user.id, body.newPassword as string);
      await audit("settings.password.changed", { username: session.username });
      const response = NextResponse.json({ ok: true, username: user.username });
      response.headers.set("Set-Cookie", sessionCookie(createSession(user.username, version, user.id), request));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    const [current, storedPreferences] = await Promise.all([getCredentials(), getPreferences()]);
    const username = validateUsername((body.username as string | undefined) || current.username);
    if (username.toLowerCase() !== current.username.toLowerCase() && await isUserUsername(username)) throw new AppError("That username is already in use", 409, "USERNAME_TAKEN");
    const passwordChanged = Boolean(body.newPassword);
    const credentialsChanged = username !== current.username || passwordChanged;
    const uploadOwnership = body.uploadOwnership === undefined
      ? storedPreferences.uploadOwnership
      : parseUploadOwnershipPreference(body.uploadOwnership);
    const ownershipChanged = JSON.stringify(uploadOwnership) !== JSON.stringify(storedPreferences.uploadOwnership);
    const trashRetentionDays = body.trashRetentionDays === undefined ? storedPreferences.trashRetentionDays : parseTrashRetention(body.trashRetentionDays);
    const retentionChanged = trashRetentionDays !== storedPreferences.trashRetentionDays;
    if (body.uploadInPieces !== undefined && typeof body.uploadInPieces !== "boolean") throw new AppError("Choose whether large files upload in pieces", 400, "INVALID_REQUEST");
    const uploadInPieces = body.uploadInPieces ?? storedPreferences.uploadInPieces;
    const piecesChanged = uploadInPieces !== storedPreferences.uploadInPieces;

    if (credentialsChanged) {
      if (!body.currentPassword) throw new AppError("Current password is required to change sign-in details", 400, "CURRENT_PASSWORD_REQUIRED");
      if (!(await verifyPassword(body.currentPassword as string, current.passwordHash))) {
        await audit("settings.credentials.failed", { username: session.username });
        throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
      }
      if (body.newPassword) validateNewPassword(body.newPassword as string);
    }

    if (ownershipChanged && uploadOwnership.mode === "fixed" && !(await isKnownIdentityPair(uploadOwnership.uid, uploadOwnership.gid))) {
      throw new AppError("Choose an owner and group available on this server", 400, "INVALID_UPLOAD_OWNERSHIP");
    }
    if (!credentialsChanged && !ownershipChanged && !retentionChanged && !piecesChanged) throw new AppError("No preference changes to save", 400, "NO_CHANGES");

    const updatedAt = new Date().toISOString();
    let credentialVersion = current.version;
    if (credentialsChanged) {
      const passwordHash = body.newPassword ? await hashPassword(body.newPassword as string) : undefined;
      // Applied to the latest credentials through their update queue, so a two-factor change made
      // meanwhile (and anything else stored with them) is kept.
      credentialVersion = await updateCredentials(async (latest) => {
        const next = { ...latest, username, passwordHash: passwordHash ?? latest.passwordHash, version: latest.version + 1, updatedAt };
        return { next, result: next.version };
      });
    }
    if (ownershipChanged || retentionChanged || piecesChanged) await savePreferences({ ...storedPreferences, uploadOwnership, trashRetentionDays, uploadInPieces, updatedAt });
    await audit("settings.preferences.updated", {
      previousUsername: current.username,
      username,
      passwordChanged,
      uploadOwnership: ownershipChanged ? uploadOwnership : undefined,
      trashRetentionDays: retentionChanged ? trashRetentionDays : undefined,
      uploadInPieces: piecesChanged ? uploadInPieces : undefined,
    });
    // A shorter retention takes effect straight away rather than at the next hourly check.
    if (retentionChanged && trashRetentionDays) void runTrashRetention().catch((error: unknown) => console.error("Could not purge expired trash", error));

    const response = NextResponse.json({ ok: true, username, uploadOwnership, trashRetentionDays, uploadInPieces });
    if (credentialsChanged) response.headers.set("Set-Cookie", sessionCookie(createSession(username, credentialVersion), request));
    response.headers.set("Cache-Control", "no-store");
    return response;
    });
  } catch (error) {
    return jsonError(error);
  }
}
