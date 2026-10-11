// Compares two texts line by line (Myers' algorithm), for showing them side by side: which lines are
// the same, removed from the left, or added on the right, with long unchanged stretches folded away
// and the changed part of a changed line marked. Texts that differ too much are reported as such
// rather than compared at great cost.

export type DiffOp = { type: "same" | "removed" | "added"; left?: number; right?: number; text: string };

/** One line of one side: its number (from 1) and text, and the changed part of it (start, end). */
export type DiffCell = { line: number; text: string; changed?: [number, number] };
export type DiffRow =
  | { kind: "same" | "changed" | "removed" | "added"; left?: DiffCell; right?: DiffCell }
  | { kind: "fold"; count: number; from: number };

export const MAX_EDITS = 5_000;

/** The lines of a text (a final newline doesn't make an empty last line). */
export function lines(text: string) {
  const split = text.split(/\r\n|\n|\r/);
  if (split.length > 1 && split.at(-1) === "") split.pop();
  return text === "" ? [] : split;
}

/**
 * The edits that turn `a` into `b`, or null when it would take more than `maxEdits` (the work and
 * memory grow with the square of that).
 */
export function diffLines(a: string[], b: string[], maxEdits = MAX_EDITS): DiffOp[] | null {
  // What's the same at the start and end needs no searching.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  const middle: DiffOp[] = [];
  // Lines only added or only removed count against the limit too.
  if ((n === 0 || m === 0) && n + m > maxEdits) return null;
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i += 1) middle.push({ type: "removed", left: start + i, text: a[start + i] });
    for (let j = 0; j < m; j += 1) middle.push({ type: "added", right: start + j, text: b[start + j] });
  } else {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    // Each step's furthest points, from -d to d, to walk back along at the end.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= Math.min(max, maxEdits); d += 1) {
      trace.push(v.slice(offset - d, offset + d + 1));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = d;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) return null;
    // Walk back from the end, step by step.
    let x = n;
    let y = m;
    const backwards: DiffOp[] = [];
    for (let d = found; d > 0; d -= 1) {
      // The furthest points before step d, saved from diagonal -d (index 0) to d.
      const previous = trace[d];
      const at = (k: number) => previous[k + d];
      const k = x - y;
      const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
      const previousK = down ? k + 1 : k - 1;
      const previousX = at(previousK);
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) {
        x -= 1;
        y -= 1;
        backwards.push({ type: "same", left: start + x, right: start + y, text: a[start + x] });
      }
      if (down) {
        y -= 1;
        backwards.push({ type: "added", right: start + y, text: b[start + y] });
      } else {
        x -= 1;
        backwards.push({ type: "removed", left: start + x, text: a[start + x] });
      }
    }
    while (x > 0 && y > 0) {
      x -= 1;
      y -= 1;
      backwards.push({ type: "same", left: start + x, right: start + y, text: a[start + x] });
    }
    // One at a time: spreading a long list into push() goes past what a call can take.
    for (let index = backwards.length - 1; index >= 0; index -= 1) middle.push(backwards[index]);
  }
  const out: DiffOp[] = [];
  for (let index = 0; index < start; index += 1) out.push({ type: "same", left: index, right: index, text: a[index] });
  for (const op of middle) out.push(op);
  for (let index = endA; index < a.length; index += 1) out.push({ type: "same", left: index, right: endB + (index - endA), text: a[index] });
  return out;
}

/** Where two versions of a line differ: the stretch between what they share at each end. */
function changedParts(left: string, right: string): [[number, number], [number, number]] {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  // Never between the two halves of a character (an emoji, say).
  if (start > 0 && isHighSurrogate(left.charCodeAt(start - 1))) start -= 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end += 1;
  if (end > 0 && isLowSurrogate(left.charCodeAt(left.length - end))) end -= 1;
  return [[start, left.length - end], [start, right.length - end]];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Every row side by side: removed and added lines next to each other pair up as changed lines. */
export function allRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let index = 0; index < ops.length;) {
    if (ops[index].type === "same") {
      const op = ops[index];
      rows.push({ kind: "same", left: { line: op.left! + 1, text: op.text }, right: { line: op.right! + 1, text: op.text } });
      index += 1;
      continue;
    }
    const removed: DiffOp[] = [];
    const added: DiffOp[] = [];
    while (index < ops.length && ops[index].type !== "same") {
      (ops[index].type === "removed" ? removed : added).push(ops[index]);
      index += 1;
    }
    for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
      const l = removed[i];
      const r = added[i];
      if (l && r) {
        const [leftPart, rightPart] = changedParts(l.text, r.text);
        rows.push({ kind: "changed", left: { line: l.left! + 1, text: l.text, changed: leftPart }, right: { line: r.right! + 1, text: r.text, changed: rightPart } });
      } else if (l) rows.push({ kind: "removed", left: { line: l.left! + 1, text: l.text } });
      else rows.push({ kind: "added", right: { line: r.right! + 1, text: r.text } });
    }
  }
  return rows;
}

/**
 * The rows with unchanged stretches longer than twice `context` folded down to `context` lines
 * either side (a fold's `from` and `count` say which of `rows` it stands for). Texts with nothing
 * changed have no rows at all.
 */
export function foldRows(rows: DiffRow[], context = 3): DiffRow[] {
  if (rows.every((row) => row.kind === "same")) return [];
  const folded: DiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== "same") {
      folded.push(rows[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].kind === "same") end += 1;
    const first = index === 0;
    const last = end === rows.length;
    const keepBefore = first ? 0 : context;
    const keepAfter = last ? 0 : context;
    if (end - index > keepBefore + keepAfter + 1) {
      for (let row = index; row < index + keepBefore; row += 1) folded.push(rows[row]);
      folded.push({ kind: "fold", count: end - index - keepBefore - keepAfter, from: index + keepBefore });
      for (let row = end - keepAfter; row < end; row += 1) folded.push(rows[row]);
    } else for (let row = index; row < end; row += 1) folded.push(rows[row]);
    index = end;
  }
  return folded;
}

/** Side-by-side rows with long unchanged stretches folded. */
export function sideBySide(ops: DiffOp[], context = 3): DiffRow[] {
  return foldRows(allRows(ops), context);
}
