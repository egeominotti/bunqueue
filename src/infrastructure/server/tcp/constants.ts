/** TCP transport settings: fixed limits and the env-backed, validated tunables. */

import {
  assertDuration,
  assertInteger,
  parseDurationEnv,
  parseIntegerEnv,
} from '../../../shared/durations';
import { warnConfigOnce } from '../../../config/warnings';

export const MAX_CONCURRENT_PER_CONNECTION = 50;

/**
 * TCP_IDLE_TIMEOUT_MS: the slowloris stall timeout for a connection holding a partial
 * frame, whole milliseconds >= 0 (0 disables), default 60000; longer than 2^31 - 1 ms is
 * honoured. A negative or unreadable value disables it with a warning, as 2.9.10 did
 * (`Math.max(0, parseInt(...) || 0)`). The single definition of the rule: this module's
 * accessor and the server configuration (`src/config/settings.ts`) both read it.
 */
export const TCP_IDLE_TIMEOUT_SETTING = {
  env: 'TCP_IDLE_TIMEOUT_MS',
  min: 0,
  fallback: 60_000,
  invalid: 0,
} as const;

/**
 * TCP_MAX_WRITE_QUEUE_BYTES: buffered outbound bytes per connection before it is
 * dropped, a whole number >= 0 (0 disables), default 64 MiB; a negative or unreadable
 * value disables it with a warning, as 2.9.10 did. Also read by `src/config/settings.ts`.
 */
export const TCP_MAX_WRITE_QUEUE_SETTING = {
  env: 'TCP_MAX_WRITE_QUEUE_BYTES',
  min: 0,
  fallback: 64 * 1024 * 1024,
  unit: 'bytes',
  invalid: 0,
} as const;

/**
 * The TCP_IDLE_TIMEOUT_MS value. Read when the TCP server is created, so a malformed
 * value fails an embedded/programmatic server there; the standalone server reports it
 * earlier, from resolveServerConfig.
 */
export function tcpIdleTimeoutMs(): number {
  const { env, fallback, min, invalid } = TCP_IDLE_TIMEOUT_SETTING;
  return parseDurationEnv(env, Bun.env[env], fallback, { min, invalid, warn: warnConfigOnce });
}

/** The TCP_MAX_WRITE_QUEUE_BYTES value (see `tcpIdleTimeoutMs` for when it is read). */
export function tcpMaxWriteQueueBytes(): number {
  const { env, fallback, min, unit, invalid } = TCP_MAX_WRITE_QUEUE_SETTING;
  return parseIntegerEnv(env, Bun.env[env], fallback, { min, unit, invalid, warn: warnConfigOnce });
}

/**
 * `TcpServerConfig.idleTimeoutMs` when set (a finite number of ms >= 0; 0 disables),
 * otherwise TCP_IDLE_TIMEOUT_MS. NaN, negatives and Infinity throw a RangeError.
 */
export function resolveIdleTimeoutMs(configured: number | undefined): number {
  return configured === undefined || configured === null
    ? tcpIdleTimeoutMs()
    : assertDuration(configured, 'TcpServerConfig.idleTimeoutMs');
}

/**
 * `TcpServerConfig.maxWriteQueueBytes` when set (a whole number >= 0; 0 disables),
 * otherwise TCP_MAX_WRITE_QUEUE_BYTES. Anything else throws a TypeError/RangeError.
 */
export function resolveMaxWriteQueueBytes(configured: number | undefined): number {
  if (configured === undefined || configured === null) return tcpMaxWriteQueueBytes();
  return assertInteger(configured, 'TcpServerConfig.maxWriteQueueBytes', {
    min: 0,
    unit: 'bytes',
  });
}
