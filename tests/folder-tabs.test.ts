import assert from "node:assert/strict";
import test from "node:test";
import { closeTab, MAX_TABS, openTab, parseTabs, shownTabs } from "../lib/folder-tabs";

test("a new tab opens beside the one showing, and the one showing follows the folder open", () => {
  const first = openTab(null, "Photos", "Music")!;
  assert.deepEqual(first, { paths: ["Photos", "Music"], active: 1 });
  // Browsing in a tab changes that tab.
  assert.deepEqual(shownTabs(first, "Music/Albums"), { paths: ["Photos", "Music/Albums"], active: 1 });
  const back = { ...first, active: 0 };
  assert.deepEqual(openTab(back, "Photos/2024", "Docs"), { paths: ["Photos/2024", "Docs", "Music"], active: 1 });
  // There's a limit.
  const full = { paths: Array.from({ length: MAX_TABS }, (_, index) => `f${index}`), active: 0 };
  assert.equal(openTab(full, "f0", "more"), null);
});

test("closing a tab shows its neighbour, and one folder left means no tabs", () => {
  const tabs = { paths: ["a", "b", "c"], active: 1 };
  assert.deepEqual(closeTab(tabs, 1), { tabs: { paths: ["a", "c"], active: 1 }, show: "c" });
  assert.deepEqual(closeTab(tabs, 0), { tabs: { paths: ["b", "c"], active: 0 }, show: null });
  assert.deepEqual(closeTab(tabs, 2), { tabs: { paths: ["a", "b"], active: 1 }, show: null });
  assert.deepEqual(closeTab({ paths: ["a", "b"], active: 1 }, 1), { tabs: null, show: "a" });
  assert.deepEqual(closeTab({ paths: ["a", "b"], active: 1 }, 0), { tabs: null, show: null });
});

test("remembered tabs are only used when they read right", () => {
  assert.deepEqual(parseTabs(JSON.stringify({ paths: ["", "Docs"], active: 1 })), { paths: ["", "Docs"], active: 1 });
  assert.deepEqual(parseTabs(JSON.stringify({ paths: ["a", "b"], active: 7 })), { paths: ["a", "b"], active: 0 });
  assert.equal(parseTabs(JSON.stringify({ paths: Array.from({ length: 40 }, (_, index) => `f${index}`), active: 0 }))!.paths.length, MAX_TABS);
  for (const raw of [null, "", "not json", "[]", JSON.stringify({ paths: ["only"] }), JSON.stringify({ paths: ["a", 2] }), JSON.stringify({ paths: ["a", "x".repeat(5000)] })]) assert.equal(parseTabs(raw), null, String(raw));
});
