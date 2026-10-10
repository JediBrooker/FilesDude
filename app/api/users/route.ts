import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { cancelAccountUploads } from "@/lib/chunked-uploads";
import { cancelAccountJobs } from "@/lib/jobs";
import { removeAccountPasskeys } from "@/lib/passkeys";
import { resetTwoFactor } from "@/lib/two-factor";
import { createUser, deleteUser, listUsers, updateUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async () => NextResponse.json({ users: await listUsers() }, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

type UsersBody = { action?: unknown; id?: unknown; username?: unknown; password?: unknown; role?: unknown; root?: unknown };

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 16 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as UsersBody;
      const id = typeof body.id === "string" && body.id.length <= 64 ? body.id : "";
      let user;
      switch (body.action) {
        case "create":
          user = await createUser({ username: body.username, password: body.password, role: body.role, root: body.root });
          await audit("users.create", { username: session.username, account: user.username, role: user.role, root: user.root });
          break;
        case "update": {
          if (!id) throw new AppError("Choose an account", 400, "INVALID_REQUEST");
          user = await updateUser(id, { role: body.role, root: body.root, password: body.password });
          // Jobs keep the role and folder they started with, so they stop along with the old sessions.
          cancelAccountJobs(id);
          await cancelAccountUploads(id);
          // A password reset is for a forgotten or exposed password: passkeys added with it go too.
          const passkeysRemoved = body.password !== undefined ? await removeAccountPasskeys(id) : 0;
          await audit("users.update", { username: session.username, account: user.username, role: user.role, root: user.root, passwordReset: body.password !== undefined, passkeysRemoved: passkeysRemoved || undefined });
          break;
        }
        case "resetTwoFactor": {
          // For a lost authenticator: the account signs in with its password again and can set it up anew.
          if (!id) throw new AppError("Choose an account", 400, "INVALID_REQUEST");
          await resetTwoFactor(id);
          cancelAccountJobs(id);
          await cancelAccountUploads(id);
          // A synced passkey usually lives on the same lost phone, so it goes too.
          const passkeysRemoved = await removeAccountPasskeys(id);
          user = (await listUsers()).find((item) => item.id === id);
          await audit("users.two_factor_reset", { username: session.username, account: user?.username, passkeysRemoved: passkeysRemoved || undefined });
          break;
        }
        case "delete":
          if (!id) throw new AppError("Choose an account", 400, "INVALID_REQUEST");
          user = await deleteUser(id);
          cancelAccountJobs(id);
          await cancelAccountUploads(id);
          await removeAccountPasskeys(id);
          await audit("users.delete", { username: session.username, account: user.username });
          break;
        default:
          throw new AppError("Unknown account operation", 400, "UNKNOWN_ACTION");
      }
      return NextResponse.json({ ok: true, user, users: await listUsers() }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
