/**
 * Worker-registry settings shared by the WorkerManager and the server's worker views
 * (ListWorkers, dashboard, WebSocket/SSE snapshots, HTTP queue workers, Cloud). Each
 * setting has exactly one accessor; it parses the env var on first use, not at import,
 * and then caches the value for the process. A malformed value throws `Invalid NAME: ...`.
 * QueueManager construction reads both (through its WorkerManager), so the error stops
 * server startup or the first embedded Queue/Worker. The server applies its resolved
 * WORKER_TIMEOUT_MS with `configureWorkerTimeoutMs` before that (the config file's
 * `timeouts.worker` is ignored, as it always was).
 */

import { assertDuration, parseDurationEnv } from './durations';

/**
 * WORKER_TIMEOUT_MS: whole milliseconds >= 1, default 30000. A worker whose last
 * heartbeat is older is stale, and the registry removes it after 3x this value; 0 would
 * mark every worker stale at once. Also read by `src/config/settings.ts`.
 */
export const WORKER_TIMEOUT_SETTING = {
  env: 'WORKER_TIMEOUT_MS',
  min: 1,
  fallback: 30_000,
} as const;

/**
 * WORKER_CLEANUP_INTERVAL_MS: whole milliseconds >= 1, default 60000, the period of the
 * stale-worker sweep. 0 would be a 1 ms spin; values above the native timer limit are
 * honoured (`safeInterval`). Also read by `src/config/settings.ts`.
 */
export const WORKER_CLEANUP_INTERVAL_SETTING = {
  env: 'WORKER_CLEANUP_INTERVAL_MS',
  min: 1,
  fallback: 60_000,
} as const;

type EnvSource = Readonly<Record<string, string | undefined>>;

let resolvedWorkerTimeoutMs: number | undefined;
let resolvedCleanupIntervalMs: number | undefined;

/** Parse WORKER_TIMEOUT_MS from `env` (no caching). */
function parseWorkerTimeoutEnv(env: EnvSource = Bun.env): number {
  const { env: name, min, fallback } = WORKER_TIMEOUT_SETTING;
  return parseDurationEnv(name, env[name], fallback, { min });
}

/** Parse WORKER_CLEANUP_INTERVAL_MS from `env` (no caching). */
function parseWorkerCleanupIntervalEnv(env: EnvSource = Bun.env): number {
  const { env: name, min, fallback } = WORKER_CLEANUP_INTERVAL_SETTING;
  return parseDurationEnv(name, env[name], fallback, { min });
}

/** The worker freshness window (see WORKER_TIMEOUT_SETTING). */
export function workerTimeoutMs(): number {
  resolvedWorkerTimeoutMs ??= parseWorkerTimeoutEnv();
  return resolvedWorkerTimeoutMs;
}

/** The stale-worker sweep period (see WORKER_CLEANUP_INTERVAL_SETTING). */
export function workerCleanupIntervalMs(): number {
  resolvedCleanupIntervalMs ??= parseWorkerCleanupIntervalEnv();
  return resolvedCleanupIntervalMs;
}

/**
 * Set the worker freshness window for the process (the server applies its resolved
 * configuration, WORKER_TIMEOUT_MS > default, before it builds the
 * QueueManager). Validated with the env rule.
 */
export function configureWorkerTimeoutMs(ms: number): void {
  resolvedWorkerTimeoutMs = assertDuration(ms, 'workerTimeoutMs', {
    min: WORKER_TIMEOUT_SETTING.min,
    integer: true,
  });
}
