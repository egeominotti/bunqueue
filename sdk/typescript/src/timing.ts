/**
 * The legacy entry's one bridge to the shared timer and duration helpers.
 *
 * Bun and Node.js arm a timer whose delay is NaN, negative or above 2^31 - 1 ms after
 * about 1 ms, so an unchecked option became a hot loop or a spurious timeout. The
 * legacy sources arm every option-driven timer through these helpers and validate
 * options with the same functions as the main client. They are imported, not copied:
 * the portable build bundles `src/shared/timers.ts` and `src/shared/durations.ts`
 * (dependency-free, no Bun globals) into the same chunk the default entry already
 * uses, so the two entries cannot drift. See docs/features/shared-timers.md.
 */

import { safeTimeout } from '../../../src/shared/timers.js';

export {
  assertDuration,
  assertInteger,
  describeValue,
  type DurationOptions,
} from '../../../src/shared/durations.js';
export {
  MAX_TIMER_DELAY_MS,
  safeInterval,
  safeTimeout,
  type SafeTimer,
} from '../../../src/shared/timers.js';

/** Resolve after `ms` (any validated delay, even beyond the native timer limit). */
export function safeSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    safeTimeout(resolve, ms);
  });
}
