import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../lib/config";
import { largestFiles } from "../lib/files";

async function withTempRoot<T>(run: (root: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-largest-"));
  const original = config.root;
  config.root = root;
  try {
    return await run(root);
  } finally {
    config.root = original;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("largestFiles sorts by size, filters by minimum size, and paginates", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "big.bin"), Buffer.alloc(3000));
    await fs.writeFile(path.join(root, "medium.bin"), Buffer.alloc(2000));
    await fs.writeFile(path.join(root, "nested", "small.bin"), Buffer.alloc(100));

    const first = await largestFiles({ refresh: true, limit: 2 });
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.deepEqual(first.entries.map((entry) => entry.name), ["big.bin", "medium.bin"]);
    assert.equal(first.totalMatching, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.scannedFiles, 3);

    const filtered = await largestFiles({ minBytes: 1500 });
    assert.equal(filtered.status, "ready");
    if (filtered.status !== "ready") return;
    assert.equal(filtered.cached, true);
    assert.deepEqual(filtered.entries.map((entry) => entry.name), ["big.bin", "medium.bin"]);
    assert.equal(filtered.totalMatching, 2);
    assert.equal(filtered.hasMore, false);
  });
});

test("a scan that outruns the poll window reports progress and can be polled to completion", async () => {
  await withTempRoot(async (root) => {
    const directoryCount = 20;
    const filesPerDirectory = 20;
    for (let index = 0; index < directoryCount; index += 1) {
      const directory = path.join(root, `dir-${index}`);
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(Array.from({ length: filesPerDirectory }, (_unused, fileIndex) =>
        fs.writeFile(path.join(directory, `file-${fileIndex}.bin`), Buffer.alloc(fileIndex + 1))));
    }
    const totalFiles = directoryCount * filesPerDirectory;

    const first = await largestFiles({ refresh: true, pollTimeoutMs: 0 });
    assert.equal(first.status, "scanning");
    if (first.status !== "scanning") return;
    assert.ok(first.progress.scannedFiles >= 0);
    assert.ok(first.progress.scannedDirectories >= 0);
    assert.ok(first.progress.elapsedMs >= 0);

    let outcome = await largestFiles({ pollTimeoutMs: 5_000 });
    let guard = 0;
    while (outcome.status === "scanning" && guard < 50) {
      outcome = await largestFiles({ pollTimeoutMs: 5_000 });
      guard += 1;
    }
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.equal(outcome.totalMatching, totalFiles);
    assert.equal(outcome.scannedFiles, totalFiles);
  });
});
