import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { clientAddress, reachedOverHttps } from "../lib/auth";
import { config } from "../lib/config";
import { allowLongRequests, DEFAULT_REQUEST_TIMEOUT_MS, installPeerStamp, REQUEST_TIMEOUT_MS } from "../lib/peer";

// A real server, so requests arrive over a real connection with whatever headers the client sends.
async function withServer<T>(run: (send: (headers: Record<string, string>) => Promise<{ address: string; https: boolean }>) => Promise<T>) {
  installPeerStamp();
  const server = http.createServer((request, response) => {
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])) as [string, string][]);
    const webRequest = new Request(`http://${request.headers.host}${request.url}`, { headers });
    response.end(JSON.stringify({ address: clientAddress(webRequest), https: reachedOverHttps(webRequest) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const original = { trustedProxies: config.trustedProxies, trustProxy: config.trustProxy };
  try {
    return await run(async (headers) => (await fetch(`http://127.0.0.1:${port}/`, { headers })).json());
  } finally {
    Object.assign(config, original);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const forged = { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "198.51.100.4", "x-forwarded-proto": "https" };

test("a direct connection is its own address, whatever it claims", async () => {
  await withServer(async (send) => {
    Object.assign(config, { trustedProxies: [], trustProxy: false });
    assert.deepEqual(await send(forged), { address: "127.0.0.1", https: false });
    // Even a forged copy of FilesDude's own stamp is overwritten.
    assert.deepEqual(await send({ ...forged, "x-filesdude-peer": "anything:192.168.0.3" }), { address: "127.0.0.1", https: false });
  });
});

test("requests may take up to an hour only while uploads go in one request", async () => {
  installPeerStamp();
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
  try {
    allowLongRequests(false);
    await request();
    assert.equal(server.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
    allowLongRequests(true);
    await request();
    assert.equal(server.requestTimeout, REQUEST_TIMEOUT_MS);
  } finally {
    allowLongRequests(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("behind a trusted proxy, the client address it reports is used", async () => {
  await withServer(async (send) => {
    Object.assign(config, { trustedProxies: ["127.0.0.1"], trustProxy: false });
    assert.deepEqual(await send(forged), { address: "198.51.100.4", https: true });
    // Without Cloudflare's header, the nearest address the proxies added.
    assert.equal((await send({ "x-forwarded-for": "10.9.9.9, 203.0.113.7, 127.0.0.1" })).address, "203.0.113.7");
    assert.equal((await send({})).address, "127.0.0.1");
    // Nonsense in the headers is ignored.
    assert.equal((await send({ "cf-connecting-ip": "not-an-address", "x-forwarded-for": "also bad" })).address, "127.0.0.1");
  });
});

test("a proxy that isn't trusted isn't believed", async () => {
  await withServer(async (send) => {
    Object.assign(config, { trustedProxies: ["192.168.0.3"], trustProxy: false });
    assert.deepEqual(await send(forged), { address: "127.0.0.1", https: false });
  });
});
