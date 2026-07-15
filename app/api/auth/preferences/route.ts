import { NextResponse } from "next/server";
import { createSession, requireSession, sessionCookie, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getCredentials, hashPassword, saveCredentials, validateNewPassword, validateUsername } from "@/lib/credentials";
import { assertMutationRequest, AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    return NextResponse.json({ username: session.username }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await requireSession(request);
    const body = (await request.json()) as { currentPassword?: string; username?: string; newPassword?: string };
    if (!body.currentPassword) throw new AppError("Current password is required", 400, "CURRENT_PASSWORD_REQUIRED");

    const current = await getCredentials();
    if (!(await verifyPassword(body.currentPassword, current.passwordHash))) {
      await audit("settings.credentials.failed", { username: session.username });
      throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
    }

    const username = validateUsername(body.username || current.username);
    const passwordChanged = Boolean(body.newPassword);
    if (body.newPassword) validateNewPassword(body.newPassword);
    if (username === current.username && !passwordChanged) throw new AppError("Enter a new username or password", 400, "NO_CHANGES");

    const updated = {
      username,
      passwordHash: body.newPassword ? await hashPassword(body.newPassword) : current.passwordHash,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await saveCredentials(updated);
    await audit("settings.credentials.updated", { previousUsername: current.username, username, passwordChanged });

    const response = NextResponse.json({ ok: true, username });
    response.headers.set("Set-Cookie", sessionCookie(createSession(username, updated.version), request));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
