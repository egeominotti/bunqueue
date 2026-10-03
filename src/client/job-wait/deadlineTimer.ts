/**
 * A timer for an absolute deadline of any length.
 *
 * Bun and Node.js accept a timer delay of at most 2^31 - 1 ms (about 24.8 days); a
 * longer one prints a TimeoutOverflowWarning and fires after 1 ms. A wait TTL can be
 * longer, so its deadline is armed in chunks that each fit in one timer.
 */

/** The longest delay armed at once: 24 days, under the runtime's 2^31 - 1 ms limit. */
export const DEADLINE_CHUNK_MS = 24 * 24 * 60 * 60 * 1000;

/** An armed deadline. */
export interface DeadlineTimer {
  /** Cancel the deadline: clears the chunk armed now. */
  clear(): void;
}

/**
 * Run `fire` once `Date.now()` reaches `deadline` (epoch ms), arming at most `chunkMs`
 * at a time. Each chunk measures what remains against the clock, so neither its
 * drift nor a chunk that fires early moves the deadline. A deadline already past
 * fires on the next timer tick. The timers are ref'd, as one `setTimeout` is.
 */
export function armDeadlineTimer(
  deadline: number,
  fire: () => void,
  chunkMs = DEADLINE_CHUNK_MS
): DeadlineTimer {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const remaining = Math.ceil(deadline - Date.now());
    timer = setTimeout(
      () => {
        if (deadline - Date.now() > 0) arm();
        else fire();
      },
      Math.min(Math.max(0, remaining), chunkMs)
    );
  };
  arm();
  return { clear: () => clearTimeout(timer) };
}
