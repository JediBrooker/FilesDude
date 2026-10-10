import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { getNotificationSettings, saveNotificationSettings, sendTestNotification } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** The owner's notification settings (the ntfy token is never sent back, only whether there is one). */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async () => NextResponse.json(await getNotificationSettings(), noStore));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const parsed = await readJsonBody<unknown>(request, 8 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("Request body is invalid", 400, "INVALID_REQUEST");
      const body = parsed as { action?: unknown; kind?: unknown; url?: unknown; token?: unknown; topics?: unknown };
      if (body.action === "save") {
        const settings = await saveNotificationSettings(body);
        await audit("settings.notifications", { username: session.username, kind: settings.kind ?? "off", topics: Object.entries(settings.topics).filter(([, on]) => on).map(([topic]) => topic) });
        return NextResponse.json(settings, noStore);
      }
      if (body.action === "test") {
        await sendTestNotification();
        return NextResponse.json({ ok: true }, noStore);
      }
      throw new AppError("Unknown notifications operation", 400, "UNKNOWN_ACTION");
    });
  } catch (error) {
    return jsonError(error);
  }
}
