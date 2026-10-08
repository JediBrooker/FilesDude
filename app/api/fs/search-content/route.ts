import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { searchContents } from "@/lib/content-search";
import { assertSameOriginFetch, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One search runs at a time (each may read up to 256 MB); a new search cancels the previous one.
let current: { controller: AbortController; done: Promise<unknown> } | null = null;

export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    await requireSession(request);
    const url = new URL(request.url);
    const previous = current;
    previous?.controller.abort();
    await previous?.done.catch(() => undefined);
    const controller = new AbortController();
    const search = searchContents(url.searchParams.get("path") || "", url.searchParams.get("q") || "", {
      caseSensitive: url.searchParams.get("case") === "1",
      showHidden: url.searchParams.get("hidden") === "true",
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    const entry = { controller, done: search };
    current = entry;
    try {
      return NextResponse.json(await search, { headers: { "Cache-Control": "no-store" } });
    } finally {
      if (current === entry) current = null;
    }
  } catch (error) {
    return jsonError(error);
  }
}
