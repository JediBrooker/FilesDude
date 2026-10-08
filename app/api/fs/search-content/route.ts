import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { searchContents } from "@/lib/content-search";
import { assertSameOriginFetch, AppError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One search runs at a time (each may read up to 256 MB). A new search claims the slot at once,
// cancels the previous search, and waits briefly for it to stop; a search replaced while waiting
// gives up, and a previous search that won't stop can't hold up later ones for long.
type Slot = { controller: AbortController; done: Promise<void>; finish: () => void };
const STOP_WAIT_MS = 5_000;
let current: Slot | null = null;

function newSlot(): Slot {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { controller: new AbortController(), done, finish };
}

export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    return await withAccess(request, "read", async () => {
    const url = new URL(request.url);
    const slot = newSlot();
    const previous = current;
    current = slot;
    try {
      if (previous) {
        previous.controller.abort();
        const stopped = await Promise.race([previous.done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_WAIT_MS))]);
        if (!stopped) throw new AppError("The previous search is still stopping; try again in a moment", 503, "SEARCH_BUSY");
      }
      if (current !== slot || slot.controller.signal.aborted) throw new AppError("A newer search replaced this one", 409, "SEARCH_REPLACED");
      const result = await searchContents(url.searchParams.get("path") || "", url.searchParams.get("q") || "", {
        caseSensitive: url.searchParams.get("case") === "1",
        showHidden: url.searchParams.get("hidden") === "true",
        signal: AbortSignal.any([request.signal, slot.controller.signal]),
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally {
      slot.finish();
      if (current === slot) current = null;
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
