/** Wall-clock milliseconds with sub-millisecond resolution, comparable across processes
 *  on the same machine (both sides derive it from the system clock). */
export const now = (): number => performance.timeOrigin + performance.now();

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export interface LatencySummary {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
}

export function summarize(values: number[]): LatencySummary {
  const sorted = Float64Array.from(values).sort();
  const arr = Array.from(sorted);
  let sum = 0;
  for (const v of arr) sum += v;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    count: arr.length,
    p50: round(percentile(arr, 50)),
    p90: round(percentile(arr, 90)),
    p99: round(percentile(arr, 99)),
    p999: round(percentile(arr, 99.9)),
    max: round(arr[arr.length - 1] ?? Number.NaN),
    mean: round(arr.length ? sum / arr.length : Number.NaN),
  };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A realistic ~200-byte job payload (a transactional email), the same for every run. */
export function payload(index: number): Record<string, unknown> {
  return {
    userId: 100_000 + index,
    email: `user${index}@example.com`,
    template: 'order-confirmation',
    locale: 'en-US',
    orderId: `ord_${(index * 2_654_435_761) >>> 0}`,
    items: 3,
    total: 129.9,
  };
}
