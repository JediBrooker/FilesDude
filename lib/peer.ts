import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

/**
 * The network address each request's connection really comes from. Route handlers can't see the
 * socket, and the x-forwarded-for header Next.js fills in can be supplied by the client, so at
 * startup FilesDude stamps every incoming request with its connection's address, signed with a
 * secret only this process knows: a client can send the header, but not one that passes.
 */
const HEADER = "x-filesdude-peer";
// Node ends any request still arriving after 5 minutes. With uploading in pieces turned off, a large
// file comes in one request, which may need longer, so the server then allows an hour. With pieces on
// (the default) no request needs more, and the shorter limit keeps slow requests from piling up.
export const REQUEST_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
const LONG_REQUESTS_KEY = Symbol.for("filesdude.longRequests");

/** Whether requests may take up to an hour (set from the preference whenever it's read or saved). */
export function allowLongRequests(allowed: boolean) {
  (globalThis as typeof globalThis & { [LONG_REQUESTS_KEY]?: boolean })[LONG_REQUESTS_KEY] = allowed;
}

const requestTimeout = () => ((globalThis as typeof globalThis & { [LONG_REQUESTS_KEY]?: boolean })[LONG_REQUESTS_KEY] ? REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS);
const SECRET_KEY = Symbol.for("filesdude.peerSecret");
type WithSecret = typeof globalThis & { [SECRET_KEY]?: string };

export function normalizeAddress(value: string | undefined | null) {
  const address = (value ?? "").trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return net.isIP(address) ? address : "";
}

/**
 * Stamps every request this process serves with its connection's address (once per process), and
 * keeps the server's request timeout in step with the uploads preference.
 */
export function installPeerStamp() {
  const global = globalThis as WithSecret;
  if (global[SECRET_KEY]) return;
  const secret = crypto.randomBytes(24).toString("hex");
  global[SECRET_KEY] = secret;
  const emit = http.Server.prototype.emit as (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;
  http.Server.prototype.emit = function stamped(this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const timeout = requestTimeout();
      if (this.requestTimeout !== timeout) this.requestTimeout = timeout;
      const request = args[0] as http.IncomingMessage;
      request.headers[HEADER] = `${secret}:${normalizeAddress(request.socket?.remoteAddress)}`;
    }
    return emit.call(this, event, ...args);
  } as typeof http.Server.prototype.emit;
}

/** The connection's address, or "" when it isn't known (the stamp isn't installed or doesn't match). */
export function connectionPeer(request: Request) {
  const secret = (globalThis as WithSecret)[SECRET_KEY];
  const value = request.headers.get(HEADER) ?? "";
  if (!secret || !value.startsWith(`${secret}:`)) return "";
  return normalizeAddress(value.slice(secret.length + 1));
}
