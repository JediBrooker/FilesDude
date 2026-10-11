import assert from "node:assert/strict";
import test from "node:test";
import { gatherSmall, squarify } from "../lib/treemap";

test("each item's rectangle has its share of the space, inside it and without overlapping", () => {
  const values = [600, 300, 120, 60, 30, 6, 1];
  const rects = squarify(values.map((value, index) => ({ value, data: index })), 1000, 600);
  assert.equal(rects.length, values.length);
  const total = values.reduce((sum, value) => sum + value, 0);
  for (const rect of rects) {
    assert.ok(Math.abs(rect.width * rect.height - (rect.value / total) * 600_000) < 1e-6, `item ${rect.data}`);
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.width <= 1000 + 1e-6 && rect.y + rect.height <= 600 + 1e-6, `item ${rect.data} inside`);
  }
  for (const [index, a] of rects.entries()) {
    for (const b of rects.slice(index + 1)) {
      const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-6, `${a.data} and ${b.data} overlap`);
    }
  }
  // Largest first, and the big ones reasonably square.
  assert.equal(rects[0].data, 0);
  assert.ok(Math.max(rects[0].width / rects[0].height, rects[0].height / rects[0].width) < 3);
});

test("nothing to draw gives no rectangles, and empty or odd values are left out", () => {
  assert.deepEqual(squarify([], 100, 100), []);
  assert.deepEqual(squarify([{ value: 0, data: "a" }], 100, 100), []);
  assert.deepEqual(squarify([{ value: 5, data: "a" }], 0, 100), []);
  assert.deepEqual(squarify([{ value: 5, data: "a" }, { value: Number.NaN, data: "b" }, { value: -3, data: "c" }], 10, 10).map((rect) => [rect.data, rect.width, rect.height]), [["a", 10, 10]]);
});

test("many small items are gathered into one", () => {
  const items = [{ value: 900, data: "big" }, ...Array.from({ length: 50 }, (_, index) => ({ value: 2, data: `small${index}` }))];
  const gathered = gatherSmall(items, 0.01, (count, value) => `${count} more (${value})`);
  assert.deepEqual(gathered.map((item) => [item.data, item.value]), [["big", 900], ["50 more (100)", 100]]);
  // Values that aren't numbers are left out rather than spoiling the rest.
  assert.deepEqual(gatherSmall([{ value: 5, data: "a" }, { value: Number.NaN, data: "b" }, { value: undefined as unknown as number, data: "c" }], 0.01, () => "rest").map((item) => item.data), ["a"]);
  // A single small item stays itself.
  assert.deepEqual(gatherSmall([{ value: 99, data: "a" }, { value: 1, data: "b" }], 0.05, () => "rest").map((item) => item.data), ["a", "b"]);
});
