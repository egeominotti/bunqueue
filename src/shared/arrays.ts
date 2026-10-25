/**
 * Array helpers that stay correct for any length. Spreading a large array into a call
 * (`push(...items)`, `Math.max(...values)`) passes every element as an argument and throws
 * `RangeError: Maximum call stack size exceeded` somewhere past a few hundred thousand.
 */

/** Same result as `target.push(...items)`, for any number of items. */
export function appendAll<T>(target: T[], items: readonly T[]): T[] {
  for (let i = 0; i < items.length; i++) target.push(items[i]);
  return target;
}

/** Same result as `Math.min(...values)`, for any number of values. */
export function minOf(values: readonly number[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i++) min = Math.min(min, values[i]);
  return min;
}

/** Same result as `Math.max(...values)`, for any number of values. */
export function maxOf(values: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]);
  return max;
}

/**
 * Same result as `items.sort(compare).slice(start, end)` (a stable sort), without sorting
 * everything when the page is small: the first `end` items are selected with a bounded
 * heap, O(n log end). `compare` must be a total order on the items for the shortcut; any
 * other case (negative or large bounds, `unordered` items) sorts the whole array.
 */
export function sortedPage<T>(
  items: T[],
  start: number,
  end: number,
  compare: (left: T, right: T) => number,
  unordered: (item: T) => boolean = () => false
): T[] {
  const k = end;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(k) ||
    start < 0 ||
    k <= 0 ||
    k * 4 >= items.length
  ) {
    return items.sort(compare).slice(start, end);
  }

  // Stable order: ties keep their original index, exactly as Array.prototype.sort.
  const before = (a: number, b: number): boolean => {
    const order = compare(items[a], items[b]);
    return order < 0 || (order === 0 && a < b);
  };
  // Max-heap (by `before`) of the k best indices seen so far.
  const heap: number[] = [];
  const siftUp = (index: number): void => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(heap[parent], heap[index])) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const siftDown = (index: number): void => {
    while (true) {
      const left = 2 * index + 1;
      const right = left + 1;
      let largest = index;
      if (left < heap.length && before(heap[largest], heap[left])) largest = left;
      if (right < heap.length && before(heap[largest], heap[right])) largest = right;
      if (largest === index) return;
      [heap[largest], heap[index]] = [heap[index], heap[largest]];
      index = largest;
    }
  };
  for (let i = 0; i < items.length; i++) {
    // An unordered item anywhere means the full sort decides, exactly as before
    if (unordered(items[i])) return items.sort(compare).slice(start, end);
    if (heap.length < k) {
      heap.push(i);
      siftUp(heap.length - 1);
    } else if (before(i, heap[0])) {
      heap[0] = i;
      siftDown(0);
    }
  }
  heap.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  return heap.slice(start, end).map((index) => items[index]);
}
