/**
 * Timestamps sent to the bunqueue Cloud dashboard, always within the JavaScript Date
 * range. A legacy job row can hold a non-finite run time (an old "never due" value):
 * msgpack, the encoding of both Cloud channels, preserves ±Infinity, and the dashboard's
 * `new Date(Infinity).toISOString()` throws a RangeError. ±Infinity is clamped to the
 * last representable instant (+/-8.64e15 ms, which keeps "far future" and "far past"
 * in order); NaN, which has no position in time, becomes `fallback`.
 */

import { MAX_DATE_MS } from '../../domain/job/options';

export function cloudTimestamp(ms: number, fallback = 0): number {
  if (Number.isNaN(ms)) return fallback;
  if (ms > MAX_DATE_MS) return MAX_DATE_MS;
  if (ms < -MAX_DATE_MS) return -MAX_DATE_MS;
  return ms;
}

/** `cloudTimestamp` for an optional field: null and undefined stay undefined. */
export function optionalCloudTimestamp(ms: number | null | undefined): number | undefined {
  return ms === null || ms === undefined ? undefined : cloudTimestamp(ms);
}
