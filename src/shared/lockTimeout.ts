/** Default lock acquisition timeout shared by lock implementations. */

import { assertDuration, parseDurationEnv } from './durations';

/**
 * The LOCK_TIMEOUT_MS rule, the single definition read by this module and by the
 * server configuration table (`src/config/settings.ts`; the config-file key
 * `timeouts.lock` is ignored, as it always was):
 * whole milliseconds >= 1 (0 would fail every contended acquire at once), default 5000.
 */
export const LOCK_TIMEOUT_SETTING = { env: 'LOCK_TIMEOUT_MS', min: 1, fallback: 5_000 } as const;

let resolvedLockTimeoutMs: number | undefined;

/** Parse LOCK_TIMEOUT_MS from `env` (no caching): `Invalid LOCK_TIMEOUT_MS: ...` if malformed. */
function parseLockTimeoutEnv(env: Readonly<Record<string, string | undefined>> = Bun.env): number {
  const { env: name, min, fallback } = LOCK_TIMEOUT_SETTING;
  return parseDurationEnv(name, env[name], fallback, { min });
}

/**
 * The default AsyncLock/RWLock acquisition timeout. Parsed from LOCK_TIMEOUT_MS on first
 * use, not at import, and then cached for the process, unless the server configured it
 * first (`configureLockTimeoutMs`, with its resolved LOCK_TIMEOUT_MS). A malformed value throws
 * `Invalid LOCK_TIMEOUT_MS: ...`; QueueManager construction reads it first, so the error
 * stops server startup or the first embedded Queue/Worker. This is the single accessor
 * for the setting.
 */
export function lockTimeoutMs(): number {
  resolvedLockTimeoutMs ??= parseLockTimeoutEnv();
  return resolvedLockTimeoutMs;
}

/**
 * Set the lock timeout for the process (the server applies its resolved configuration,
 * LOCK_TIMEOUT_MS > default, before it builds the QueueManager; the config file's
 * `timeouts.lock` is ignored).
 * Validated with the env rule; later acquisitions use the new value.
 */
export function configureLockTimeoutMs(ms: number): void {
  resolvedLockTimeoutMs = assertDuration(ms, 'lockTimeoutMs', {
    min: LOCK_TIMEOUT_SETTING.min,
    integer: true,
  });
}
