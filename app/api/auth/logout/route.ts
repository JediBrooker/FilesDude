import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { assertMutationRequest, jsonError } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const session = await getSession(request);
    const response = NextResponse.json({ authenticated: false });
    response.headers.set("Set-Cookie", clearSessionCookie(request));
    response.headers.set("Cache-Control", "no-store");
    if (session) await audit("logout", { username: session.username });
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
