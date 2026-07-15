import { NextResponse } from "next/server";
import { configurationIssues } from "@/lib/config";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const issues = configurationIssues();
  const session = await getSession(request);
  return NextResponse.json({
    authenticated: Boolean(session),
    username: session?.username || null,
    configured: issues.length === 0,
    configurationIssues: issues,
  });
}
