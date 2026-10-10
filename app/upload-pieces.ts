// Sending a large file in pieces, for the file manager and for upload-link pages. Files larger than
// PIECES_ABOVE_BYTES are sent this way, so no request is bigger than a proxy such as Cloudflare
// allows (100 MB), and a dropped connection only costs the piece in flight.
export const PIECES_ABOVE_BYTES = 64 * 1024 * 1024;

type RequestError = Error & { status?: number; code?: string; received?: number };

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-filedude-request", "1");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code, received: data.received }) as RequestError;
  return data as T;
}

function sendPiece(url: string, piece: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<{ received: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) => onProgress(Math.min(piece.size, event.loaded));
    xhr.onload = () => {
      settle();
      let data: { error?: string; code?: string; received?: number } = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        // Non-JSON error pages fall back to the status message below.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { received: number });
      else reject(Object.assign(new Error(data.error || `Request failed (${xhr.status})`), { status: xhr.status, code: data.code, received: data.received }));
    };
    xhr.onerror = () => { settle(); reject(new Error("The connection was interrupted during the upload")); };
    xhr.onabort = () => { settle(); reject(new DOMException("The upload was cancelled", "AbortError")); };
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-filedude-request", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(piece);
  });
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("The upload was cancelled", "AbortError")); }, { once: true });
});

/**
 * Uploads `file` in pieces to `base` (starting with `start` added to the start request, and `query`
 * on it). A piece that fails for a lost connection or a busy server is sent again (after asking the
 * server where to carry on), up to a few times in a row before giving up.
 */
export async function uploadInPieces<T>(target: { base: string; query?: string; start?: Record<string, unknown> }, file: File, onProgress: (loaded: number) => void, signal: AbortSignal) {
  const { base } = target;
  const at = (id: string, offset?: number) => `${base}?id=${encodeURIComponent(id)}${offset === undefined ? "" : `&offset=${offset}`}`;
  const { id, chunkBytes } = await call<{ id: string; chunkBytes: number }>(target.query ? `${base}?${target.query}` : base, { method: "POST", body: JSON.stringify({ ...target.start, action: "start", name: file.name, size: file.size }), signal });
  let received = 0;
  let failures = 0;
  try {
    while (received < file.size) {
      const from = received;
      try {
        const result = await sendPiece(at(id, from), file.slice(from, Math.min(file.size, from + chunkBytes)), (loaded) => onProgress(from + loaded), signal);
        received = result.received;
        failures = 0;
      } catch (caught) {
        const typed = caught as RequestError;
        if (typed.name === "AbortError") throw caught;
        // Only a lost connection, a busy or restarting server, or a piece out of step is worth retrying.
        const retryable = typed.status === undefined || typed.status === 409 || typed.status === 429 || typed.status >= 500;
        failures += 1;
        if (!retryable || failures > 5) throw caught;
        await pause(Math.min(30_000, 1_000 * 2 ** failures), signal);
        received = typed.received ?? (await call<{ received: number }>(at(id), { signal }).then((status) => status.received, () => received));
        onProgress(received);
      }
    }
    return await call<T>(base, { method: "POST", body: JSON.stringify({ action: "finish", id }), signal });
  } catch (caught) {
    // The server would remove it after a while anyway; this frees the space now.
    void call(base, { method: "POST", body: JSON.stringify({ action: "cancel", id }) }).catch(() => undefined);
    throw caught;
  }
}
