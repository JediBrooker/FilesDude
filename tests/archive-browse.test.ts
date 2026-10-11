import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";
import tarStream from "tar-stream";
import { createSession } from "../lib/auth";
import { clearArchiveCatalogs, listArchive, readArchiveEntry } from "../lib/archive-browse";
import { archiveSelection, extractArchive } from "../lib/archives";
import { config } from "../lib/config";
import { getCredentials } from "../lib/credentials";
import { runInScope } from "../lib/scope";
import { GET as archiveEntry } from "../app/api/fs/archive-entry/route";

const noProgress = () => undefined;

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function withRoot<T>(run: (root: string, cookie: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-archive-browse-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const salt = crypto.randomBytes(16);
  const original = { root: config.root, stateDir: config.stateDir, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret };
  Object.assign(config, {
    root,
    stateDir: path.join(base, "state"),
    passwordHash: `scrypt$16384$8$1$${salt.toString("base64url")}$${(await scrypt("archive-test-password", salt)).toString("base64url")}`,
    sessionSecret: "archive-browse-test-session-secret-with-more-than-32-characters",
  });
  clearArchiveCatalogs();
  try {
    const credentials = await getCredentials();
    return await run(root, `fd_session=${createSession(credentials.username, credentials.version)}`);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function tarFile(file: string, entries: Array<{ name: string; type?: "file" | "directory" | "symlink"; body?: string; linkname?: string }>, gzip = false) {
  const pack = tarStream.pack();
  for (const entry of entries) {
    if (entry.type === "directory") pack.entry({ name: entry.name, type: "directory" });
    else if (entry.type === "symlink") pack.entry({ name: entry.name, type: "symlink", linkname: entry.linkname });
    else pack.entry({ name: entry.name }, entry.body ?? "");
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, gzip ? zlib.gzipSync(data) : data);
}

// A minimal stored (uncompressed) zip, so tests can include names that zip tools refuse to write.
async function zipFile(file: string, entries: Array<{ name: string; body: string }>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.body);
    const crc = zlib.crc32(body);
    // Names that aren't plain ASCII are marked as UTF-8.
    const flags = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([...locals, directory, end]));
}

async function text(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const names = (listing: Awaited<ReturnType<typeof listArchive>>) => listing.items.map((item) => `${item.name}${item.type === "directory" ? `/ (${item.items})` : item.type === "link" ? " ->" : ` ${item.size}`}`);

test("a zip's folders are listed, including ones only its files' paths name, without unsafe entries", async () => {
  await withRoot(async (root) => {
    await zipFile(path.join(root, "backup.zip"), [
      { name: "docs/a.txt", body: "alpha" },
      { name: "docs/sub/deep.txt", body: "deep" },
      { name: "readme.md", body: "# hi" },
      { name: "photos/", body: "" },
      { name: "../escape.txt", body: "no" },
      { name: "/etc/passwd", body: "no" },
      { name: "docs/.filedude/x", body: "no" },
    ]);
    const top = await listArchive("backup.zip");
    assert.deepEqual(names(top), ["docs/ (2)", "photos/ (0)", "readme.md 4"]);
    assert.deepEqual([top.format, top.entries, top.unsafe, top.truncated], ["zip", 7, 3, false]);
    assert.deepEqual(names(await listArchive("backup.zip", "docs")), ["sub/ (1)", "a.txt 5"]);
    assert.deepEqual(names(await listArchive("backup.zip", "docs/sub/")), ["deep.txt 4"]);
    for (const folder of ["missing", "readme.md", "../docs", "docs/.filedude"]) await assert.rejects(listArchive("backup.zip", folder), /isn't in this archive/, folder);
  });
});

test("names nested too deeply or too long are left out, and listing them stays cheap", async () => {
  await withRoot(async (root) => {
    const deep = Array.from({ length: 70 }, () => "a").join("/");
    const long = `${"b".repeat(250)}/`.repeat(20) + "file.txt";
    await tarFile(path.join(root, "deep.tar"), [{ name: `${deep}/x.txt`, body: "x" }, { name: long, body: "y" }, { name: "fine/ok.txt", body: "ok" }]);
    const started = Date.now();
    const listing = await listArchive("deep.tar");
    assert.deepEqual([names(listing), listing.unsafe], [["fine/ (1)"], 2]);
    assert.ok(Date.now() - started < 2_000);
    // Many entries deep inside one folder list that folder's parents only once.
    await zipFile(path.join(root, "wide.zip"), Array.from({ length: 300 }, (_, index) => ({ name: `${"d/".repeat(60)}f${index}.txt`, body: "z" })));
    assert.deepEqual(names(await listArchive("wide.zip")), ["d/ (1)"]);
  });
});

test("a gzipped tar is listed, with links shown but never treated as files", async () => {
  await withRoot(async (root) => {
    await tarFile(path.join(root, "site.tar.gz"), [
      { name: "site/", type: "directory" },
      { name: "site/index.html", body: "<script>alert(1)</script>" },
      { name: "site/latest", type: "symlink", linkname: "/etc/shadow" },
    ], true);
    const listing = await listArchive("site.tar.gz", "site");
    assert.equal(listing.format, "tar.gz");
    assert.deepEqual(names(listing), ["index.html 25", "latest ->"]);
    await assert.rejects(readArchiveEntry("site.tar.gz", "site/latest"), /isn't in this archive/);
    assert.equal(await text((await readArchiveEntry("site.tar.gz", "site/index.html")).stream), "<script>alert(1)</script>");
  });
});

test("one file is read from inside a zip or tar, and nothing else can be", async () => {
  await withRoot(async (root) => {
    await zipFile(path.join(root, "a.zip"), [{ name: "x/one.txt", body: "first" }, { name: "x/one.txt", body: "repeated" }, { name: "two.txt", body: "second" }]);
    await tarFile(path.join(root, "b.tar"), [{ name: "one.txt", body: "tar one" }, { name: "later/two.txt", body: "tar two" }]);
    // A repeated name gives its first copy, as the listing shows.
    assert.equal(await text((await readArchiveEntry("a.zip", "x/one.txt")).stream), "first");
    assert.equal(await text((await readArchiveEntry("a.zip", "two.txt")).stream), "second");
    assert.equal(await text((await readArchiveEntry("b.tar", "later/two.txt")).stream), "tar two");
    for (const name of ["x", "missing.txt", "../two.txt", ""]) await assert.rejects(readArchiveEntry("a.zip", name), /isn't in this archive/, name);
    // Only archives, inside the root.
    await fs.writeFile(path.join(root, "notes.txt"), "plain");
    await assert.rejects(listArchive("notes.txt"), /archives can be opened/);
    await assert.rejects(listArchive("../a.zip"));
  });
});

test("a changed archive is read again, not served from what was read before", async () => {
  await withRoot(async (root) => {
    await zipFile(path.join(root, "c.zip"), [{ name: "old.txt", body: "o" }]);
    assert.deepEqual(names(await listArchive("c.zip")), ["old.txt 1"]);
    await zipFile(path.join(root, "c.zip"), [{ name: "new.txt", body: "newer" }]);
    assert.deepEqual(names(await listArchive("c.zip")), ["new.txt 5"]);
  });
});

test("accounts only look inside archives in their own folder", async () => {
  await withRoot(async (root) => {
    await zipFile(path.join(root, "home/bob/mine.zip"), [{ name: "a.txt", body: "a" }]);
    await zipFile(path.join(root, "home/alice/hers.zip"), [{ name: "b.txt", body: "b" }]);
    await runInScope({ accountKey: "bob", username: "bob", role: "viewer", root: "home/bob" }, async () => {
      assert.equal((await listArchive("home/bob/mine.zip")).items.length, 1);
      await assert.rejects(listArchive("home/alice/hers.zip"));
      await assert.rejects(readArchiveEntry("home/alice/hers.zip", "b.txt"));
    });
  });
});

test("chosen items are extracted on their own into a new folder, placed relative to their folder", async () => {
  await withRoot(async (root) => {
    await zipFile(path.join(root, "pack.zip"), [
      { name: "docs/a.txt", body: "a" }, { name: "docs/b.txt", body: "b" }, { name: "docs/sub/c.txt", body: "c" }, { name: "other.txt", body: "o" },
    ]);
    await tarFile(path.join(root, "pack2.tar.gz"), [{ name: "top/keep.txt", body: "k" }, { name: "top/skip.txt", body: "s" }], true);
    const result = await extractArchive("pack.zip", noProgress, new AbortController().signal, {}, archiveSelection(["docs/a.txt", "docs/sub"]));
    assert.equal(result.path, "pack");
    assert.deepEqual((await fs.readdir(path.join(root, "pack"))).sort(), ["a.txt", "sub"]);
    assert.equal(await fs.readFile(path.join(root, "pack/sub/c.txt"), "utf8"), "c");
    await extractArchive("pack2.tar.gz", noProgress, new AbortController().signal, {}, archiveSelection(["top/keep.txt"]));
    assert.deepEqual(await fs.readdir(path.join(root, "pack2")), ["keep.txt"]);
    // Items from different folders, unsafe names, and items not in the archive are refused.
    assert.throws(() => archiveSelection(["docs/a.txt", "other.txt"]), /one folder/);
    for (const bad of [["../x"], ["/etc"], [".filedude/trash"], [], "docs"]) assert.throws(() => archiveSelection(bad), JSON.stringify(bad));
    await assert.rejects(extractArchive("pack.zip", noProgress, new AbortController().signal, {}, archiveSelection(["nothing-here"])), /aren't in this archive/);
    // An unsafe entry elsewhere doesn't stop chosen items, though it stops extracting everything.
    await zipFile(path.join(root, "mixed.zip"), [{ name: "good/ok.txt", body: "ok" }, { name: "../evil.txt", body: "no" }]);
    await assert.rejects(extractArchive("mixed.zip", noProgress, new AbortController().signal), /unsafe path/);
    await extractArchive("mixed.zip", noProgress, new AbortController().signal, {}, archiveSelection(["good/ok.txt"]));
    assert.deepEqual(await fs.readdir(path.join(root, "mixed")), ["ok.txt"]);
    assert.equal(await fs.stat(path.join(path.dirname(root), "evil.txt")).catch(() => null), null);
    await fs.rm(path.join(root, "mixed"), { recursive: true });
    await fs.rm(path.join(root, "mixed.zip"));
    assert.deepEqual((await fs.readdir(root)).sort(), ["pack", "pack.zip", "pack2", "pack2.tar.gz"]);
  });
});

test("files from archives are only shown as safe kinds: web pages and scripts arrive as plain text", async () => {
  await withRoot(async (root, cookie) => {
    await zipFile(path.join(root, "web.zip"), [{ name: "page.html", body: "<script>alert(1)</script>" }, { name: "pic.svg", body: "<svg onload=alert(1)/>" }, { name: "tool.exe", body: "MZ" }, { name: "photo.png", body: "png" }, { name: "été \"q\".txt", body: "t" }]);
    const get = (entry: string, extra = "", headers: Record<string, string> = {}) => archiveEntry(new Request(`http://localhost/api/fs/archive-entry?path=web.zip&entry=${encodeURIComponent(entry)}${extra}`, { headers: { cookie, ...headers } }));
    const html = await get("page.html");
    assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await html.text(), "<script>alert(1)</script>");
    assert.equal((await get("pic.svg")).headers.get("content-type"), "text/plain; charset=utf-8");
    const exe = await get("tool.exe");
    assert.equal(exe.headers.get("content-type"), "application/octet-stream");
    assert.match(exe.headers.get("content-disposition") ?? "", /^attachment/);
    await exe.body?.cancel();
    const png = await get("photo.png");
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.match(png.headers.get("content-disposition") ?? "", /^inline/);
    await png.body?.cancel();
    const download = await get("été \"q\".txt", "&download=1");
    assert.equal(download.headers.get("content-disposition"), `attachment; filename="_t_ _q_.txt"; filename*=UTF-8''${encodeURIComponent("été \"q\".txt")}`);
    await download.body?.cancel();
    // Requests given up on, before or while reading, don't keep their slots (three per account).
    for (let round = 0; round < 4; round += 1) {
      const gone = await archiveEntry(new Request("http://localhost/api/fs/archive-entry?path=web.zip&entry=page.html", { headers: { cookie }, signal: AbortSignal.abort() })).catch(() => null);
      await gone?.body?.cancel().catch(() => undefined);
      const read = await get("page.html");
      await read.body?.cancel();
    }
    assert.equal((await get("page.html")).status, 200);
    // Other sites can't load them.
    assert.equal((await get("photo.png", "", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await archiveEntry(new Request("http://localhost/api/fs/archive-entry?path=web.zip&entry=photo.png"))).status, 401);
  });
});
