import assert from "node:assert/strict";
import test from "node:test";
import { moveCursor, selectionRange } from "../lib/selection";

const order = ["a", "b", "c", "d", "e"];

test("selects the inclusive range between anchor and target in either direction", () => {
  assert.deepEqual(selectionRange(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(selectionRange(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(selectionRange(order, "c", "c"), ["c"]);
});

test("falls back to the target when the anchor is no longer listed", () => {
  assert.deepEqual(selectionRange(order, "gone", "c"), ["c"]);
  assert.deepEqual(selectionRange(order, "a", "gone"), []);
});

test("moves through a list with up, down, home, and end", () => {
  assert.equal(moveCursor(-1, 5, "ArrowDown"), 0);
  assert.equal(moveCursor(-1, 5, "ArrowUp"), 4);
  assert.equal(moveCursor(2, 5, "ArrowDown"), 3);
  assert.equal(moveCursor(4, 5, "ArrowDown"), 4);
  assert.equal(moveCursor(0, 5, "ArrowUp"), 0);
  assert.equal(moveCursor(3, 5, "Home"), 0);
  assert.equal(moveCursor(1, 5, "End"), 4);
  assert.equal(moveCursor(1, 5, "ArrowRight"), null);
  assert.equal(moveCursor(1, 5, "x"), null);
  assert.equal(moveCursor(-1, 0, "ArrowDown"), null);
});

test("moves across and down a grid, stopping at the edges", () => {
  const layout = { grid: true, columns: 3 };
  assert.equal(moveCursor(1, 8, "ArrowRight", layout), 2);
  assert.equal(moveCursor(1, 8, "ArrowLeft", layout), 0);
  assert.equal(moveCursor(1, 8, "ArrowDown", layout), 4);
  assert.equal(moveCursor(6, 8, "ArrowDown", layout), 7);
  assert.equal(moveCursor(4, 8, "ArrowUp", layout), 1);
  assert.equal(moveCursor(1, 8, "ArrowUp", layout), 0);
});
