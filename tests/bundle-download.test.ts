import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";
import { appendBundle, bundleName, bundlePaths, checkBundle, createDownloadTicket, takeDownloadTicket } from "../lib/bundle-download";
import { config } from "../lib/config";
import { runInScope } from "../lib/scope";

async function withRoot<T>(run: (root: string) => Promise<T>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-bundle-")));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const original = { root: config.root, stateDir: config.stateDir };
  Object.assign(config, { root, stateDir: path.join(base, "state") });
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function write(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

// Builds the ZIP in memory and reads it back: entry name to contents ("/" for folders).
async function zipOf(paths: string[], signal?: AbortSignal) {
  const archive = new ZipArchive();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => archive.on("end", resolve));
  await appendBundle(archive, paths, signal);
  await archive.finalize();
  await done;
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(Buffer.concat(chunks), { lazyEntries: true }, (error, file) => (error ? reject(error) : resolve(file))));
  const contents: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) {
        contents[entry.fileName] = "/";
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return reject(error);
        const parts: Buffer[] = [];
        for await (const part of stream) parts.push(part as Buffer);
        contents[entry.fileName] = Buffer.concat(parts).toString();
        zip.readEntry();
      });
    });
    zip.readEntry();
  });
  return contents;
}

test("a selection is normalised: duplicates and items inside selected folders are dropped", () => {
  assert.deepEqual(bundlePaths(["docs/a.txt", "/docs/a.txt", "docs", "docs/sub/b.txt", "photos/x.jpg", "docs2/c.txt"]), ["docs", "photos/x.jpg", "docs2/c.txt"]);
  assert.throws(() => bundlePaths([]), /at least one/);
  assert.throws(() => bundlePaths("docs"), /at least one/);
  assert.throws(() => bundlePaths([""]), /not the whole root/);
  assert.throws(() => bundlePaths(["/"]), /not the whole root/);
  assert.throws(() => bundlePaths([42]), /Invalid path/);
  assert.throws(() => bundlePaths(["a\0b"]), /Invalid path/);
  assert.throws(() => bundlePaths(["\ud800/x", "y"]), /Invalid path/, "not well-formed Unicode");
  assert.deepEqual(bundlePaths(["a", "a/", "a//", "b/"]), ["a", "b"]);
  assert.throws(() => bundlePaths(Array.from({ length: 1001 }, (_, index) => `f${index}`)), /at most 1,000/);
});

test("the ZIP is named after the folder the items share", () => {
  assert.equal(bundleName(["photos/2024/a.jpg", "photos/2024/b.jpg"]), "2024 (2 items).zip");
  assert.equal(bundleName(["a.txt", "b.txt", "c"]), "files (3 items).zip");
  assert.equal(bundleName(["x/a.txt", "y/b.txt"]), "files (2 items).zip");
});

test("tickets work once, only for their account, and expire", () => {
  const token = createDownloadTicket("alice", ["a.txt", "b.txt"]);
  assert.equal(takeDownloadTicket(token, "bob"), null, "another account can't use it");
  assert.deepEqual(takeDownloadTicket(token, "alice")?.paths, ["a.txt", "b.txt"]);
  assert.equal(takeDownloadTicket(token, "alice"), null, "it works once");
  const late = createDownloadTicket("alice", ["a.txt", "b.txt"]);
  const now = Date.now;
  Date.now = () => now() + 3 * 60 * 1000;
  try {
    assert.equal(takeDownloadTicket(late, "alice"), null);
  } finally {
    Date.now = now;
  }
  // Only an account's latest tickets are kept.
  const tokens = Array.from({ length: 12 }, () => createDownloadTicket("carol", ["a", "b"]));
  assert.equal(takeDownloadTicket(tokens[0], "carol"), null);
  assert.ok(takeDownloadTicket(tokens[11], "carol"));
});

test("several files and folders download as one ZIP, with clashing names kept apart", async () => {
  await withRoot(async (root) => {
    await write(root, { "docs/report.txt": "report", "docs/sub/notes.md": "notes", "other/report.txt": "other report", "pic.jpg": "jpeg", "empty.txt": "" });
    await fs.symlink("../pic.jpg", path.join(root, "docs/link.jpg"));
    await fs.mkdir(path.join(root, "docs/.filedude"));
    await fs.writeFile(path.join(root, "docs/.filedude/secret"), "x");
    const paths = bundlePaths(["docs", "other/report.txt", "docs/report.txt", "pic.jpg", "empty.txt"]);
    await checkBundle(paths);
    const contents = await zipOf(paths);
    assert.deepEqual(Object.keys(contents).sort(), ["docs/", "docs/link.jpg", "docs/report.txt", "docs/sub/", "docs/sub/notes.md", "empty.txt", "pic.jpg", "report.txt"]);
    assert.equal(contents["report.txt"], "other report");
    assert.equal(contents["docs/sub/notes.md"], "notes");
    // Two selected files with the same name from different folders.
    const clash = await zipOf(["docs/report.txt", "other/report.txt"]);
    assert.deepEqual(clash, { "report.txt": "report", "report (2).txt": "other report" });
  });
});

test("the same item reached twice is added once, and names and links can't climb out of the ZIP", async () => {
  await withRoot(async (root) => {
    await write(root, { "docs/a.txt": "a", "docs/sub/b.txt": "b", "pic.jpg": "jpeg", "docs/a\\..\\..\\evil.txt": "evil" });
    await fs.symlink("docs", path.join(root, "docs-alias"));
    await fs.symlink("pic.jpg", path.join(root, "pic-alias.jpg"));
    await fs.symlink("sub/b.txt", path.join(root, "docs/inside.txt"));
    await fs.symlink("../../outside.txt", path.join(root, "docs/climbs.txt"));
    await fs.symlink("/etc/passwd", path.join(root, "docs/absolute.txt"));
    const contents = await zipOf(["docs", "docs-alias", "docs-alias/sub/b.txt", "pic.jpg", "pic-alias.jpg"]);
    assert.deepEqual(Object.keys(contents).sort(), ["docs/", "docs/a.txt", "docs/a_.._.._evil.txt", "docs/inside.txt", "docs/sub/", "docs/sub/b.txt", "pic.jpg"]);
    assert.equal(contents["docs/inside.txt"], "sub/b.txt", "a link within the ZIP is kept as a link");
    // Unicode forms and Windows' trailing dots count as clashes too.
    await write(root, { "x/café.txt": "nfc", "y/café.txt": "nfd", "z/notes.": "dot", "w/notes": "plain" });
    const clashes = Object.keys(await zipOf(["x/café.txt", "y/café.txt", "w/notes", "z/notes."])).map((name) => name.normalize("NFC"));
    assert.deepEqual(clashes.sort(), ["café (2).txt", "café.txt", "notes", "notes (2)."]);
  });
});

test("items must exist, be files or folders, and be inside the account's folder", async () => {
  await withRoot(async (root) => {
    await write(root, { "home/bob/a.txt": "a", "home/bob/b.txt": "b", "home/alice/secret.txt": "s" });
    await assert.rejects(checkBundle(["home/bob/a.txt", "home/bob/missing.txt"]));
    const viewer = { accountKey: "bob", username: "bob", role: "viewer" as const, root: "home/bob" };
    await runInScope(viewer, async () => {
      await checkBundle(["home/bob/a.txt", "home/bob/b.txt"]);
      await assert.rejects(checkBundle(["home/bob/a.txt", "home/alice/secret.txt"]));
      await assert.rejects(checkBundle(["home/bob/a.txt", "home/bob/../alice/secret.txt"]));
      // An item outside the folder slipped into a bundle is left out, never read.
      assert.deepEqual(Object.keys(await zipOf(["home/bob/a.txt", "home/alice/secret.txt"])), ["a.txt"]);
    });
    await fs.symlink(path.join(root, "home/alice/secret.txt"), path.join(root, "home/bob/sneaky.txt"));
    await runInScope(viewer, async () => {
      await assert.rejects(checkBundle(["home/bob/a.txt", "home/bob/sneaky.txt"]));
    });
  });
});

test("an item removed meanwhile is left out, and cancelling stops the ZIP", async () => {
  await withRoot(async (root) => {
    await write(root, { "a.txt": "a", "b.txt": "b" });
    const paths = ["a.txt", "b.txt"];
    await checkBundle(paths);
    await fs.rm(path.join(root, "b.txt"));
    assert.deepEqual(await zipOf(paths), { "a.txt": "a" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(zipOf(paths, controller.signal), /cancelled/);
  });
});
