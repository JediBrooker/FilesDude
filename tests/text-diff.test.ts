import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, lines, sideBySide, unfold, type DiffOp } from "../lib/text-diff";

// Applies the edits to the left lines, which must give the right ones.
function apply(left: string[], ops: DiffOp[]) {
  const out: string[] = [];
  for (const op of ops) {
    if (op.type === "same") {
      assert.equal(left[op.left!], op.text);
      out.push(op.text);
    } else if (op.type === "added") out.push(op.text);
  }
  return out;
}

test("the edits turn one text into the other, as few as possible", () => {
  const a = lines("a\nb\nc\nd\ne\nf\n");
  const b = lines("a\nc\nd\nX\ne\nf\ng\n");
  const ops = diffLines(a, b)!;
  assert.deepEqual(apply(a, ops), b);
  assert.deepEqual(ops.filter((op) => op.type !== "same").map((op) => `${op.type === "added" ? "+" : "-"}${op.text}`), ["-b", "+X", "+g"]);
  // Random edits always come back right.
  for (let round = 0; round < 50; round += 1) {
    const left = Array.from({ length: 40 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 5)));
    const right = left.filter(() => Math.random() > 0.2).flatMap((line) => (Math.random() > 0.85 ? [line, "new"] : [line]));
    assert.deepEqual(apply(left, diffLines(left, right)!), right);
  }
});

test("empty texts, identical texts, and line endings", () => {
  assert.deepEqual(lines(""), []);
  assert.deepEqual(lines("one\r\ntwo\r\n"), ["one", "two"]);
  assert.deepEqual(diffLines([], lines("x\ny"))!.map((op) => op.type), ["added", "added"]);
  assert.deepEqual(diffLines(lines("x"), [])!.map((op) => op.type), ["removed"]);
  assert.ok(diffLines(lines("same\ntext"), lines("same\ntext"))!.every((op) => op.type === "same"));
});

test("texts too different to compare cheaply say so", () => {
  const a = Array.from({ length: 3000 }, (_, index) => `left ${index}`);
  const b = Array.from({ length: 3000 }, (_, index) => `right ${index}`);
  assert.equal(diffLines(a, b, 100), null);
  assert.ok(diffLines(a.slice(0, 40), b.slice(0, 40), 100));
});

test("side by side, changed lines pair up with their changed part marked, and unchanged stretches fold", () => {
  const a = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const b = [...a];
  b[15] = "line 15 edited";
  const ops = diffLines(a, b)!;
  const rows = sideBySide(ops, 3);
  assert.deepEqual(rows.map((row) => row.kind), ["fold", "same", "same", "same", "changed", "same", "same", "same", "fold"]);
  const changed = rows[4] as Extract<typeof rows[number], { left?: unknown }>;
  assert.deepEqual([changed.left?.line, changed.right?.line, changed.right?.changed], [16, 16, [7, 14]]);
  const fold = rows[0] as Extract<typeof rows[number], { kind: "fold" }>;
  assert.equal(fold.count, 12);
  assert.deepEqual(unfold(ops, fold.from, fold.count).map((row) => (row as { left?: { line: number } }).left?.line), Array.from({ length: 12 }, (_, index) => index + 1));
  // Lines only on one side stand alone.
  assert.deepEqual(sideBySide(diffLines(["a"], ["a", "b"])!).map((row) => row.kind), ["same", "added"]);
});
