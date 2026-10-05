/**
 * PostgreSQL lease deadlines for any duration.
 *
 * `lease_until` is a BIGINT. Claims and renewals bind it through a BIGINT array, which
 * rejects a fraction, NaN or an infinity, and every reader decodes it with `numeric()`,
 * which rejects anything beyond Number.MAX_SAFE_INTEGER. A deadline built from an
 * unchecked duration (a fractional lock TTL, a NaN `stallTimeout` left in a stored
 * payload, a huge configured lease) therefore failed the claim of the queue head on
 * every attempt or wrote a row no broker could read back. These helpers are the only
 * place a lease length becomes a deadline: whatever the inputs, a deadline is a whole
 * number of milliseconds in [0, POSTGRES_NEVER_EXPIRES_MS].
 *
 * The job timeout is not interpreted here: it comes from the shared rule in
 * `src/domain/job/timeoutRule.ts` (`processingDeadline`), which the SQLite scheduler
 * and the Worker also use, so the three engines cannot drift apart.
 */
import { processingDeadline } from '../../../domain/job/timeoutRule';

/** The latest instant a JavaScript Date represents (year 275760): a lease that never expires. */
export const POSTGRES_NEVER_EXPIRES_MS = 8_640_000_000_000_000;

/** `start + durationMs` as a whole-millisecond deadline, clamped to [0, never expires]. */
export function postgresLeaseDeadline(start: number, durationMs: number): number {
  const deadline = Math.ceil(start + durationMs);
  if (!(deadline > 0)) return 0;
  return deadline < POSTGRES_NEVER_EXPIRES_MS ? deadline : POSTGRES_NEVER_EXPIRES_MS;
}

/**
 * The lease a caller asked for, in whole milliseconds and at least 1. NaN or a
 * non-number means "not specified" and uses `fallbackMs`, the configured
 * `leaseDurationMs`; Infinity, or any length past the deadline range, never expires.
 */
export function postgresRequestedLeaseMs(requestedMs: unknown, fallbackMs: number): number {
  const value =
    typeof requestedMs === 'number' && requestedMs === requestedMs ? requestedMs : fallbackMs;
  return value > 1 ? Math.ceil(value) : 1;
}

/**
 * A job's stall timeout as a lease cap in milliseconds, or null when it has none. NaN
 * and non-numbers mean none (the core stall check never fires for NaN); 0 or less
 * stalls at once, as it does in the core engine.
 */
export function postgresStallTimeoutCap(stallTimeout: unknown): number | null {
  return typeof stallTimeout === 'number' && stallTimeout === stallTimeout ? stallTimeout : null;
}

interface LeaseCaps {
  readonly timeout: unknown;
  readonly stallTimeout: unknown;
}

/**
 * The deadline a renewal (ExtendLock, JobHeartbeat with a duration) grants at `now`:
 * `leaseMs` (from `postgresRequestedLeaseMs`), never past the job's processing deadline
 * (`processingDeadline` for a generation started at `startedAt`). As on 2.9.10 it is
 * not shortened to the stall timeout: only a claim is (`postgresClaimLeaseUntil`), so a
 * Worker that heartbeats less often than the job's stallTimeout keeps its lease. A
 * deadline already due is kept, clamped to 0: an expired job is not extended.
 */
export function postgresLeaseUntil(
  now: number,
  leaseMs: number,
  startedAt: number,
  // `stallTimeout` is accepted and ignored: a renewal is not shortened to it.
  job: Pick<LeaseCaps, 'timeout'> & Partial<LeaseCaps>
): number {
  const deadline = postgresLeaseDeadline(now, leaseMs > 1 ? leaseMs : 1);
  // Any stored value: the shared rule handles a non-number as well.
  const timeoutDeadline = processingDeadline({ timeout: job.timeout as number | null, startedAt });
  if (timeoutDeadline === null || timeoutDeadline >= deadline) return deadline;
  return timeoutDeadline > 0 ? timeoutDeadline : 0;
}

/**
 * The deadline a claim grants at `now`: `leaseMs` shortened to the stall timeout (the
 * job must heartbeat within it, as 2.9.10's claim required), never past the processing
 * deadline of a generation starting now, and never less than 1 ms, so a timeout already
 * due (negative) still yields a claim whose lease the next recovery scan reports as a
 * timeout.
 */
export function postgresClaimLeaseUntil(now: number, leaseMs: number, job: LeaseCaps): number {
  const stall = postgresStallTimeoutCap(job.stallTimeout);
  const lease = stall !== null && stall < leaseMs ? stall : leaseMs;
  const deadline = postgresLeaseUntil(now, lease, now, job);
  return deadline > now ? deadline : postgresLeaseDeadline(now, 1);
}
