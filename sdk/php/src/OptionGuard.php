<?php

declare(strict_types=1);

namespace Bunqueue;

/**
 * @internal Boundary validation for durations and lease lengths.
 *
 * PHP casts NAN and INF to the integer 0, and a zero stream timeout makes `fread`
 * non-blocking. An unchecked timeout therefore became a busy-spinning read that never
 * times out, a reconnect storm (a deadline already in the past), or an uncaught
 * `ValueError` from `stream_socket_client`. Values are checked where they enter and
 * rejected with an \InvalidArgumentException naming the option.
 *
 * The heartbeat interval, batch size, poll timeout and waitForJob ttl follow
 * sdk/CLAUDE.md rule 4 (docs/protocol.md 6.3 and 9): a number is clamped, never
 * rejected. They never throw: every value bunqueue/client 0.2.0 accepted keeps the
 * setting 0.2.0 derived from it (numeric strings from the environment included),
 * except the poll timeouts that 0.2.0 broke through PHP's int cast.
 */
final class OptionGuard
{
    /** Longest accepted long-poll, in ms (the documented PULLB cap of this client). */
    private const MAX_POLL_TIMEOUT_MS = 30_000;
    private const DEFAULT_POLL_TIMEOUT_MS = 5000;
    /** The broker rejects a PULLB count above 1000. */
    private const MAX_BATCH_SIZE = 1000;
    private const DEFAULT_BATCH_SIZE = 10;
    /** The broker holds a WaitJob for at most 600000 ms. */
    private const MAX_WAIT_JOB_MS = 600_000;
    private const DEFAULT_WAIT_JOB_MS = 30_000;

    /**
     * Longest connect/command timeout PHP honours, in seconds (~24.85 days):
     * `php_tvtoto()` (main/php_network.h) turns a stream timeout above
     * `(INT_MAX - 1000) / 1000` s into an infinite poll. Above PHP_INT_MAX the
     * `(int)` cast wraps instead: 1e300 became a 0 s timeout (a busy-spinning read),
     * 2^64 + 8192 an 8192 s one. Longer values are capped here, never wrapped.
     */
    public const MAX_TIMEOUT_S = 2_147_482.0;

    /** Wait after a pull that found no job (src/client/worker/runtime/polling.ts): */
    private const EMPTY_POLL_DELAY_US = 50_000; // poll timeout 0: the main client's default drainDelay
    private const EMPTY_LONG_POLL_DELAY_US = 10_000; // poll timeout > 0: its fixed 10 ms

    /**
     * A finite int or float number of seconds > 0 (connect and command deadlines),
     * capped at MAX_TIMEOUT_S.
     */
    public static function seconds(mixed $value, string $name): float
    {
        if ((\is_int($value) || \is_float($value)) && is_finite((float) $value) && $value > 0) {
            return min((float) $value, self::MAX_TIMEOUT_S);
        }
        throw new \InvalidArgumentException(
            sprintf('%s must be a finite number of seconds > 0 (got %s)', $name, self::describe($value))
        );
    }

    /** A whole number of milliseconds >= 1 (a lease TTL: 0 or less is expired when granted). */
    public static function milliseconds(mixed $value, string $name): int
    {
        if (\is_int($value) && $value >= 1) {
            return $value;
        }
        throw new \InvalidArgumentException(
            sprintf('%s must be a whole number of milliseconds >= 1 (got %s)', $name, self::describe($value))
        );
    }

    /**
     * Long-poll timeout in ms (rule 4). An int, float or numeric string (such as
     * '5000' from the environment) is clamped to [0, 30000] before the integer cast,
     * so a huge value such as 1e19 caps at 30000 instead of wrapping to 0 as in 0.2.0.
     * NAN means 5000 and INF 30000 (0.2.0 made both 0). Any other value means 0, as in
     * 0.2.0: a non-blocking pull, which `Worker::run()` follows with a 50 ms wait.
     */
    public static function pollTimeoutMs(mixed $value): int
    {
        if (\is_string($value) && is_numeric($value)) {
            $value = (float) $value;
        }
        if (!\is_int($value) && !\is_float($value)) {
            return 0;
        }
        if (\is_float($value) && is_nan($value)) {
            return self::DEFAULT_POLL_TIMEOUT_MS;
        }
        return (int) max(0, min($value, self::MAX_POLL_TIMEOUT_MS));
    }

    /**
     * PULLB batch size (rule 4): an int is clamped to [1, 1000]. Any other value
     * (a float or a string included) means 10, exactly as in 0.2.0.
     */
    public static function batchSize(mixed $value): int
    {
        return \is_int($value) ? min(max(1, $value), self::MAX_BATCH_SIZE) : self::DEFAULT_BATCH_SIZE;
    }

    /**
     * The single WaitJob hold of waitForJob, in ms (rule 4): null or NAN means 30000;
     * any other number is clamped to [0, 600000] (INF holds for the maximum).
     */
    public static function waitJobTtlMs(int|float|null $value): int
    {
        if ($value === null || (\is_float($value) && is_nan($value))) {
            return self::DEFAULT_WAIT_JOB_MS;
        }
        return (int) max(0, min($value, self::MAX_WAIT_JOB_MS));
    }

    /**
     * Microseconds `Worker::run()` waits after a pull that found no job, as the main
     * client does: `pollTimeout > 0 ? 10 : drainDelay`. Never zero, so an idle loop
     * never re-polls at once (a 1 ms long-poll alone allowed ~1000 pulls per second).
     */
    public static function emptyPullDelayUs(int $pollTimeoutMs): int
    {
        return $pollTimeoutMs > 0 ? self::EMPTY_LONG_POLL_DELAY_US : self::EMPTY_POLL_DELAY_US;
    }

    /**
     * Heartbeat interval in seconds (rule 4), converted with `(float)` as in 0.2.0:
     * '10' means 10 s, and zero, negative, non-finite or `false` disables (0.0).
     */
    public static function heartbeatIntervalS(mixed $value): float
    {
        $seconds = (float) $value;
        return (is_finite($seconds) && $seconds > 0) ? $seconds : 0.0;
    }

    private static function describe(mixed $value): string
    {
        if (\is_int($value) || \is_float($value) || \is_bool($value)) {
            return var_export($value, true);
        }
        return \is_string($value) ? json_encode($value, JSON_UNESCAPED_UNICODE) ?: 'string' : get_debug_type($value);
    }
}
