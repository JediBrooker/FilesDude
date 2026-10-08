import { requireSession } from "@/lib/auth";
import { assertSameOriginFetch, jsonError } from "@/lib/http";
import { thumbnailFor } from "@/lib/thumbnails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertSameOriginFetch(request);
    await requireSession(request);
    const { data, etag } = await thumbnailFor(new URL(request.url).searchParams.get("path") || "", request.headers.get("if-none-match"));
    // Browsers keep a thumbnail briefly, then revalidate by ETag, which is cheap and never stale.
    const headers = { "Cache-Control": "private, max-age=300", ETag: etag, "X-Content-Type-Options": "nosniff" };
    if (!data) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(data), { headers: { ...headers, "Content-Type": "image/webp", "Content-Length": String(data.length) } });
  } catch (error) {
    return jsonError(error);
  }
}
