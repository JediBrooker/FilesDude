import { requireSession } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { thumbnailFor } from "@/lib/thumbnails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const data = await thumbnailFor(new URL(request.url).searchParams.get("path") || "");
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(data.length),
        // The browser asks with the file's modification time in the URL, so a cached copy is never stale.
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
