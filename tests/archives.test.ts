import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import tarStream from "tar-stream";
import { compressEntries, extractArchive, safeEntryPath, splitArchiveName } from "../lib/archives";
import { config } from "../lib/config";
import { getJob, startJob } from "../lib/jobs";

const noProgress = () => undefined;
const live = () => new AbortController().signal;

async function withTempRoot<T>(run: (root: string) => Promise<T>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-archive-")));
  const original = { root: config.root, stateDir: config.stateDir };
  config.root = root;
  config.stateDir = path.join(root, ".filedude");
  try {
    return await run(root);
  } finally {
    Object.assign(config, original);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function tree(directory: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(`${relative}/`, ...(await tree(path.join(directory, entry.name), `${relative}/`)));
    else if (entry.isSymbolicLink()) out.push(`${relative} -> link`);
    else out.push(`${relative}=${await fs.readFile(path.join(directory, entry.name), "utf8")}`);
  }
  return out;
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
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await fs.writeFile(file, Buffer.concat([...locals, directory, end]));
}

test("archive names split on compound extensions", () => {
  assert.deepEqual(splitArchiveName("photos.tar.gz"), ["photos", ".tar.gz"]);
  assert.deepEqual(splitArchiveName("Backup.ZIP"), ["Backup", ".ZIP"]);
  assert.deepEqual(splitArchiveName("notes.txt"), ["notes", ".txt"]);
  assert.deepEqual(splitArchiveName(".tgz"), [".tgz", ""]);
});

test("entry paths are normalized and hostile ones rejected", () => {
  assert.equal(safeEntryPath("./docs//a.txt"), "docs/a.txt");
  assert.equal(safeEntryPath("win\\path\\b.txt"), "win/path/b.txt");
  assert.equal(safeEntryPath("./"), null);
  for (const hostile of ["../evil", "a/../../evil", "/etc/passwd", "C:/Windows/x", "a/.filedude/trash/x", "bad\0name", "..\\evil"]) {
    assert.throws(() => safeEntryPath(hostile), /unsafe path/, hostile);
  }
});

for (const format of ["zip", "tar.gz"] as const) {
  test(`a ${format} round trip preserves folders and contents and never overwrites`, async () => {
    await withTempRoot(async (root) => {
      await fs.mkdir(path.join(root, "site", "assets"), { recursive: true });
      await fs.writeFile(path.join(root, "site", "index.html"), "<h1>hi</h1>");
      await fs.writeFile(path.join(root, "site", "assets", "app.js"), "run()");
      await fs.writeFile(path.join(root, "notes.txt"), "notes");
      const progress: number[] = [];

      const archive = await compressEntries(["site", "notes.txt"], "", "bundle", format, (p) => progress.push(p.done), live());
      assert.equal(archive.path, `bundle.${format}`);
      assert.ok(archive.bytes > 0);
      assert.ok(progress.length > 0);
      const again = await compressEntries(["notes.txt"], "", "bundle", format, noProgress, live());
      assert.equal(again.path, `bundle (2).${format}`);

      const extracted = await extractArchive(archive.path, noProgress, live());
      assert.equal(extracted.path, "bundle");
      assert.deepEqual(await tree(path.join(root, "bundle")), ["notes.txt=notes", "site/", "site/assets/", "site/assets/app.js=run()", "site/index.html=<h1>hi</h1>"]);
      assert.equal((await extractArchive(archive.path, noProgress, live())).path, "bundle (2)");
    });
  });
}

for (const format of ["zip", "tar.gz"] as const) {
  test(`links are stored in a ${format} but never created when extracting`, async () => {
    await withTempRoot(async (root) => {
      await fs.mkdir(path.join(root, "dir"));
      await fs.writeFile(path.join(root, "dir", "real.txt"), "real");
      await fs.symlink("/etc/passwd", path.join(root, "dir", "escape"));
      const archive = await compressEntries(["dir"], "", "links", format, noProgress, live());
      const extracted = await extractArchive(archive.path, noProgress, live());
      assert.equal(extracted.skipped, 1);
      assert.deepEqual(await tree(path.join(root, "links")), ["dir/", "dir/real.txt=real"]);
    });
  });
}

test("a tar with a path outside its folder is refused entirely", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "evil.tar"), [{ name: "ok.txt", body: "fine" }, { name: "../escaped.txt", body: "pwned" }]);
    await assert.rejects(extractArchive("evil.tar", noProgress, live()), /unsafe path \("\.\.\/escaped\.txt"\)/);
    assert.deepEqual((await fs.readdir(root)).sort(), ["evil.tar"]);
    await assert.rejects(fs.access(path.join(path.dirname(root), "escaped.txt")));
  });
});

test("a zip with a path outside its folder is refused entirely", async () => {
  await withTempRoot(async (root) => {
    await zipFile(path.join(root, "evil.zip"), [{ name: "ok.txt", body: "fine" }, { name: "../escaped.txt", body: "pwned" }]);
    await assert.rejects(extractArchive("evil.zip", noProgress, live()), /unsafe path|invalid relative path/);
    assert.deepEqual((await fs.readdir(root)).sort(), ["evil.zip"]);
    await zipFile(path.join(root, "good.zip"), [{ name: "docs/a.txt", body: "a" }, { name: "docs/a.txt", body: "duplicate" }]);
    const extracted = await extractArchive("good.zip", noProgress, live());
    assert.equal(extracted.skipped, 1);
    assert.deepEqual(await tree(path.join(root, "good")), ["docs/", "docs/a.txt=a"]);
  });
});

test("a tar symlink entry is skipped and an internal folder name is refused", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "links.tgz"), [{ name: "link", type: "symlink", linkname: "/etc" }, { name: "link/passwd", body: "x" }], true);
    // "link" is skipped, so "link/passwd" lands in a real folder inside the extraction.
    const result = await extractArchive("links.tgz", noProgress, live());
    assert.equal(result.skipped, 1);
    assert.deepEqual(await tree(path.join(root, "links")), ["link/", "link/passwd=x"]);
    await tarFile(path.join(root, "internal.tar"), [{ name: "a/.filedude/x", body: "x" }]);
    await assert.rejects(extractArchive("internal.tar", noProgress, live()), /unsafe path/);
  });
});

test("extracted content gets normal permissions only after extraction completes", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "perm.tar"), [{ name: "a/b/c.txt", body: "c" }]);
    await extractArchive("perm.tar", noProgress, live());
    const mode = async (relative: string) => (await fs.stat(path.join(root, relative))).mode & 0o777;
    assert.equal(await mode("perm"), 0o750);
    assert.equal(await mode("perm/a"), 0o750);
    assert.equal(await mode("perm/a/b"), 0o750);
    assert.equal(await mode("perm/a/b/c.txt"), 0o640);
  });
});

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("output takes the owner of the folder it is created in when running as root", { skip: !runningAsRoot && "needs root" }, async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "shared"));
    await fs.chown(path.join(root, "shared"), 4242, 4343);
    await tarFile(path.join(root, "shared", "bundle.tar"), [{ name: "docs/a.txt", body: "a" }]);
    await extractArchive("shared/bundle.tar", noProgress, live());
    for (const relative of ["shared/bundle", "shared/bundle/docs", "shared/bundle/docs/a.txt"]) {
      const stat = await fs.stat(path.join(root, relative));
      assert.deepEqual([stat.uid, stat.gid], [4242, 4343], relative);
    }
    const archive = await compressEntries(["shared/bundle"], "shared", "again", "zip", noProgress, live());
    const stat = await fs.stat(path.join(root, archive.path));
    assert.deepEqual([stat.uid, stat.gid], [4242, 4343]);
  });
});

test("archives nested more deeply than the limit are refused", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "deep.tar"), [{ name: `${"d/".repeat(70)}file.txt`, body: "x" }]);
    await assert.rejects(extractArchive("deep.tar", noProgress, live()), /more deeply than FilesDude will extract/);
    assert.deepEqual(await fs.readdir(root), ["deep.tar"]);
  });
});

test("compression leaves out FilesDude's internal folders anywhere in the tree", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "project", "sub", ".filedude"), { recursive: true });
    await fs.writeFile(path.join(root, "project", "sub", ".filedude", "secret.json"), "{}");
    await fs.writeFile(path.join(root, "project", "sub", "keep.txt"), "keep");
    const archive = await compressEntries(["project"], "", "project", "tar.gz", noProgress, live());
    await extractArchive(archive.path, noProgress, live());
    assert.deepEqual(await tree(path.join(root, "project (2)")), ["project/", "project/sub/", "project/sub/keep.txt=keep"]);
  });
});

test("extraction stops at the entry and disk-space limits and cleans up", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "many.tar"), [{ name: "a", body: "1" }, { name: "b", body: "2" }, { name: "c", body: "3" }]);
    await assert.rejects(extractArchive("many.tar", noProgress, live(), { maxEntries: 2 }), /more than 2 entries/);
    await assert.rejects(extractArchive("many.tar", noProgress, live(), { reserveBytes: Number.MAX_SAFE_INTEGER }), /enough free space/);
    assert.deepEqual(await fs.readdir(root), ["many.tar"]);
  });
});

test("unsupported files are refused without creating a folder", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "plain.txt"), "not an archive");
    await assert.rejects(extractArchive("plain.txt", noProgress, live()), /Only \.zip, \.tar/);
    assert.deepEqual(await fs.readdir(root), ["plain.txt"]);
  });
});

test("a cancelled compression leaves no partial archive", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(compressEntries(["big.bin"], "", "big", "zip", noProgress, controller.signal), /cancelled/);
    assert.deepEqual(await fs.readdir(root), ["big.bin"]);
  });
});

for (const format of ["zip", "tar.gz"] as const) {
  test(`a ${format} compression cancelled part-way stops promptly and leaves no partial archive`, async () => {
    await withTempRoot(async (root) => {
      await fs.mkdir(path.join(root, "photos"));
      for (let index = 0; index < 8; index += 1) await fs.writeFile(path.join(root, "photos", `${index}.bin`), Buffer.alloc(4 * 1024 * 1024, index));
      const controller = new AbortController();
      const started = Date.now();
      await assert.rejects(compressEntries(["photos"], "", "photos", format, (progress) => { if (progress.done > 0) controller.abort(); }, controller.signal), /cancelled/);
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual(await fs.readdir(root), ["photos"]);
    });
  });
}

test("a cancelled extraction removes its partial folder", async () => {
  await withTempRoot(async (root) => {
    await tarFile(path.join(root, "big.tar"), Array.from({ length: 6 }, (_, index) => ({ name: `f${index}.bin`, body: "x".repeat(2 * 1024 * 1024) })));
    const controller = new AbortController();
    await assert.rejects(extractArchive("big.tar", (progress) => { if (progress.done > 0) controller.abort(); }, controller.signal), /cancelled|aborted/i);
    assert.deepEqual(await fs.readdir(root), ["big.tar"]);
  });
});

test("jobs report completion and run one at a time", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = startJob("compress", "Compressing a.txt", { done: 0, unit: "bytes" }, async (report, signal) => {
      await gate;
      return compressEntries(["a.txt"], "", "a", "zip", report, signal);
    });
    assert.equal(first.status, "running");
    assert.throws(() => startJob("extract", "Extracting", { done: 0, unit: "bytes" }, async () => { throw new Error("unused"); }), /still running/);
    release();
    let state = getJob(first.id);
    for (let attempt = 0; attempt < 100 && state?.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = getJob(first.id);
    }
    assert.equal(state?.status, "done");
    assert.equal(state?.result?.path, "a.zip");
  });
});
