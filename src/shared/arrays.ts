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
