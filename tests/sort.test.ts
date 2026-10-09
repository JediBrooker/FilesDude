import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SORT, nextSort, parseSort, sortEntries } from "../lib/sort";
import type { FileEntry } from "../lib/types";

function entry(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: name,
    type: "file",
    size: 0,
    modified: "2026-01-01T00:00:00.000Z",
    created: "2026-01-01T00:00:00.000Z",
    mode: "644",
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root",
    mime: "text/plain",
    hidden: false,
    ...overrides,
  };
}

const entries = [
  entry("file10.txt", { size: 50, modified: "2026-03-01T00:00:00.000Z", owner: "alice", mode: "600" }),
  entry("File2.txt", { size: 900, modified: "2026-01-05T00:00:00.000Z", owner: "bob", mode: "755" }),
  entry("photos", { type: "directory", size: 4096, owner: "zed" }),
  entry("archive", { type: "directory", size: 64, owner: "amy" }),
  entry("b.log", { size: 900, modified: "2026-02-01T00:00:00.000Z", owner: "alice", mode: "1777" }),
];
const names = (sorted: FileEntry[]) => sorted.map((item) => item.name);

test("sorts by name naturally and case-insensitively with folders first", () => {
  assert.deepEqual(names(sortEntries(entries, DEFAULT_SORT)), ["archive", "photos", "b.log", "File2.txt", "file10.txt"]);
  assert.deepEqual(names(sortEntries(entries, { key: "name", direction: "desc" })), ["photos", "archive", "file10.txt", "File2.txt", "b.log"]);
});

test("sorts by size with name tie-breaks and folders kept in name order", () => {
  assert.deepEqual(names(sortEntries(entries, { key: "size", direction: "desc" })), ["archive", "photos", "b.log", "File2.txt", "file10.txt"]);
  assert.deepEqual(names(sortEntries(entries, { key: "size", direction: "asc" })), ["archive", "photos", "file10.txt", "b.log", "File2.txt"]);
});

test("folders sort by their counted contents when known", () => {
  const sizes = new Map([["photos", 5_000_000], ["archive", 200]]);
  assert.deepEqual(names(sortEntries(entries, { key: "size", direction: "desc" }, sizes)).slice(0, 2), ["photos", "archive"]);
  assert.deepEqual(names(sortEntries(entries, { key: "size", direction: "asc" }, sizes)).slice(0, 2), ["archive", "photos"]);
  // A folder not yet counted goes after the counted ones.
  assert.deepEqual(names(sortEntries(entries, { key: "size", direction: "desc" }, new Map([["photos", 1]]))).slice(0, 2), ["photos", "archive"]);
});

test("sorts by modified time, owner, and numeric permissions", () => {
  assert.deepEqual(names(sortEntries(entries, { key: "modified", direction: "desc" })).slice(2), ["file10.txt", "b.log", "File2.txt"]);
  assert.deepEqual(names(sortEntries(entries, { key: "owner", direction: "asc" })), ["archive", "photos", "b.log", "file10.txt", "File2.txt"]);
  assert.deepEqual(names(sortEntries(entries, { key: "mode", direction: "desc" })).slice(2), ["b.log", "File2.txt", "file10.txt"]);
});

test("does not mutate the input listing", () => {
  const before = names(entries);
  sortEntries(entries, { key: "size", direction: "desc" });
  assert.deepEqual(names(entries), before);
});

test("toggles the active column and starts new columns in their natural direction", () => {
  assert.deepEqual(nextSort(DEFAULT_SORT, "name"), { key: "name", direction: "desc" });
  assert.deepEqual(nextSort(DEFAULT_SORT, "size"), { key: "size", direction: "desc" });
  assert.deepEqual(nextSort(DEFAULT_SORT, "modified"), { key: "modified", direction: "desc" });
  assert.deepEqual(nextSort({ key: "size", direction: "desc" }, "size"), { key: "size", direction: "asc" });
});

test("reads stored preferences and falls back to the default for bad values", () => {
  assert.deepEqual(parseSort(JSON.stringify({ key: "modified", direction: "desc" })), { key: "modified", direction: "desc" });
  for (const stored of [null, "", "{", JSON.stringify({ key: "toString", direction: "asc" }), JSON.stringify({ key: "size", direction: "up" })]) {
    assert.deepEqual(parseSort(stored), DEFAULT_SORT);
  }
});
