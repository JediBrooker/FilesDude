// Lays out a treemap: each item gets a rectangle whose area is in proportion to its value, as
// close to square as the "squarified" method (Bruls, Huizing, van Wijk) manages, so they're easy
// to compare and to click.

export type TreemapRect<T> = { x: number; y: number; width: number; height: number; value: number; data: T };

type Area<T> = { value: number; area: number; data: T };
type Space = { x: number; y: number; width: number; height: number };

// The least square of a row's rectangles, laid along a side of this length (lower is better).
function worst(row: number[], side: number) {
  const sum = row.reduce((total, area) => total + area, 0);
  const largest = Math.max(...row);
  const smallest = Math.min(...row);
  return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
}

// Places a row along the shorter side of the space, returning the space left beside it.
function place<T>(row: Area<T>[], space: Space, out: TreemapRect<T>[]): Space {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (space.width >= space.height) {
    const width = sum / space.height;
    let y = space.y;
    for (const item of row) {
      const height = item.area / width;
      out.push({ x: space.x, y, width, height, value: item.value, data: item.data });
      y += height;
    }
    return { x: space.x + width, y: space.y, width: space.width - width, height: space.height };
  }
  const height = sum / space.width;
  let x = space.x;
  for (const item of row) {
    const width = item.area / height;
    out.push({ x, y: space.y, width, height, value: item.value, data: item.data });
    x += width;
  }
  return { x: space.x, y: space.y + height, width: space.width, height: space.height - height };
}

/** Rectangles for the items (those with a positive value), largest first, filling the space. */
export function squarify<T>(items: Array<{ value: number; data: T }>, width: number, height: number): TreemapRect<T>[] {
  const usable = items.filter((item) => Number.isFinite(item.value) && item.value > 0).sort((a, b) => b.value - a.value);
  const total = usable.reduce((sum, item) => sum + item.value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const queue: Area<T>[] = usable.map((item) => ({ ...item, area: item.value * scale }));
  const out: TreemapRect<T>[] = [];
  let space: Space = { x: 0, y: 0, width, height };
  let row: Area<T>[] = [];
  while (queue.length) {
    const side = Math.min(space.width, space.height);
    const next = queue[0];
    if (!row.length || worst([...row.map((item) => item.area), next.area], side) <= worst(row.map((item) => item.area), side)) row.push(queue.shift()!);
    else {
      space = place(row, space, out);
      row = [];
    }
  }
  if (row.length) place(row, space, out);
  return out;
}

/**
 * The items worth a rectangle of their own: those smaller than `share` of the total are gathered
 * into one (`rest`), so a folder of thousands of tiny files still draws as something readable.
 */
export function gatherSmall<T>(items: Array<{ value: number; data: T }>, share: number, rest: (count: number, value: number) => T) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const kept = items.filter((item) => item.value >= total * share);
  const small = items.filter((item) => item.value > 0 && item.value < total * share);
  if (small.length > 1) kept.push({ value: small.reduce((sum, item) => sum + item.value, 0), data: rest(small.length, 0) });
  else kept.push(...small);
  return kept;
}
