/** Every path between anchor and target (inclusive) in display order. */
export function selectionRange(order: string[], anchor: string, target: string) {
  const end = order.indexOf(target);
  if (end < 0) return [];
  const start = order.indexOf(anchor);
  if (start < 0) return [target];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The index a navigation key moves the cursor to, or null when the key is not a
 * navigation key for this layout. In grid view the arrows move across and down the grid.
 */
export function moveCursor(current: number, length: number, key: string, { grid = false, columns = 1 } = {}) {
  if (!length) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const rows = grid ? Math.max(1, columns) : 1;
  const steps: Record<string, number> = grid
    ? { ArrowDown: rows, ArrowUp: -rows, ArrowRight: 1, ArrowLeft: -1 }
    : { ArrowDown: 1, ArrowUp: -1 };
  const step = steps[key];
  if (step === undefined) return null;
  if (current < 0 || current >= length) return step > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + step));
}
