/**
 * Boundary validation and defaults for TCP connection options.
 *
 * Bun and Node.js run a timer whose delay is NaN, negative, not a number or above
 * 2^31 - 1 ms after about 1 ms, so an unchecked option became a Ping flood, a
 * reconnect storm, or commands and connections that fail at once. Every TcpClient
 * resolves its options here, and the shared pool and shared client registries validate
 * before they compute a sharing key, so a bad value throws where it enters, naming the
 * owner and the option. `undefined` or `null` means the default, as the pool's own
 * resolution (`??`) treats them. Long durations are valid: the client arms its timers
 * through `shared/timers.ts`, which honours any delay. Values 2.9.10 read with a
 * well-defined result (a numeric-string port, a fractional pool size, a negative
 * pingInterval...) are first rewritten to that result by `normalizeConnectionOptions`.
 * See docs/features/client-transport.md.
 */

import {
  assertDuration,
  assertInteger,
  describeValue,
  type DurationOptions,
} from '../../shared/durations';
import { DEFAULT_CONNECTION, type ConnectionOptions } from './types';
import { ceilAtLeast, coerceNumericString, isFiniteNumber } from './numeric';

type DurationKey =
  | 'connectTimeout'
  | 'commandTimeout'
  | 'pingInterval'
  | 'reconnectDelay'
  | 'maxReconnectDelay';
type CountKey = 'maxReconnectAttempts' | 'maxPingFailures' | 'maxCommandTimeouts' | 'maxInFlight';
type PoolLikeOptions = Partial<ConnectionOptions> & { poolSize?: number };

/**
 * At least 1 ms: the runtime rounds a shorter timer up to 1 ms, a 0 timeout fires
 * before any reply can arrive, and a 0 reconnect delay never backs off (0 * 2^n = 0).
 * Infinity means "never" where a duration can sensibly never elapse: no client-side
 * command deadline, no ping, a backoff capped only by `maxReconnectDelay` (or not at
 * all). `pingInterval` also accepts 0 (no ping), and a negative value is normalized to
 * 0 as 2.9.10 read it; values between 0 and 1 ms are rejected separately (a ~1 ms Ping
 * flood), and so is NaN. `reconnectDelay` accepts any value above 0: a base below 1 ms
 * still doubles on every attempt, as on 2.9.10.
 */
const DURATIONS: Record<DurationKey, DurationOptions> = {
  connectTimeout: { min: 1 },
  commandTimeout: { min: 1, allowInfinity: true },
  pingInterval: { min: 0, allowInfinity: true },
  reconnectDelay: { min: 0, allowInfinity: true },
  maxReconnectDelay: { min: 1, allowInfinity: true },
};

/**
 * Whole-number limits and their minimum; Infinity means "no limit". A fraction or a
 * value below the minimum is first normalized where 2.9.10 had a result (`REWRITES`).
 */
const COUNTS: Record<CountKey, number> = {
  maxReconnectAttempts: 0, // 0: give up when the connection is lost
  maxPingFailures: 1, // 0 would leave getHealth() unhealthy forever
  maxCommandTimeouts: 0, // 0: command timeouts never force a reconnect
  maxInFlight: 1, // 0 would never send a command
};

/**
 * Connections per pool. Below 1 means one and a fraction rounds up, as on 2.9.10
 * (`normalizeConnectionOptions`); NaN is rejected. The ceiling is the
 * number of TCP connections one client address can hold to one broker address (one
 * per local port); it also stops a typo such as 1e9 from making the constructor build
 * a billion clients until the process runs out of memory.
 */
export const MAX_POOL_SIZE = 65_535;

/** A broker port: 0 cannot be connected to, and TCP ports end at 65535. */
export const MAX_PORT = 65_535;

/** Every option, in a fixed order: the sharing keys are built from all of them. */
export const OPTION_KEYS = Object.keys(DEFAULT_CONNECTION) as Array<keyof ConnectionOptions>;

/** Throw a TypeError or a RangeError naming `owner` and the option for an invalid value. */
export function assertConnectionOptions(
  owner: string,
  input: Partial<ConnectionOptions> | null | undefined
): void {
  if (!input) return;
  const options = normalizeConnectionOptions(input);
  assertTarget(owner, options);
  const base = options.reconnectDelay;
  if (typeof base === 'number' && !(base > 0)) {
    throw new RangeError(
      `${owner}: reconnectDelay must be a number of milliseconds above 0, or Infinity (got ${describeValue(base)})`
    );
  }
  for (const key of Object.keys(DURATIONS) as DurationKey[]) {
    const value = options[key];
    if (isSet(value)) assertDuration(value, `${owner}: ${key}`, DURATIONS[key]);
  }
  const ping = options.pingInterval;
  if (isSet(ping) && ping > 0 && ping < 1) {
    throw new RangeError(
      `${owner}: pingInterval must be 0 (disabled) or at least 1 ms (got ${ping})`
    );
  }
  for (const key of Object.keys(COUNTS) as CountKey[]) {
    const value = options[key];
    if (isSet(value)) {
      assertInteger(value, `${owner}: ${key}`, { min: COUNTS[key], allowInfinity: true });
    }
  }
}

/**
 * Where to connect, and as whom. Bun refuses an empty host or a fractional or
 * out-of-range port only when a connection is attempted, and the reconnect loop then
 * retried that forever with Bun's own message; a numeric token broke the sharing key.
 */
function assertTarget(owner: string, options: Partial<ConnectionOptions>): void {
  const { host, port, token } = options;
  if (isSet(host) && (typeof host !== 'string' || host.trim() === '')) {
    const message = `${owner}: host must be a non-empty hostname or IP address (got ${describeValue(host)})`;
    throw typeof host === 'string' ? new RangeError(message) : new TypeError(message);
  }
  if (isSet(port)) assertInteger(port, `${owner}: port`, { min: 1, max: MAX_PORT });
  if (isSet(token) && typeof token !== 'string') {
    throw new TypeError(`${owner}: token must be a string (got ${describeValue(token)})`);
  }
}

/**
 * `assertConnectionOptions` plus a pool's `poolSize`: a finite number up to
 * `MAX_POOL_SIZE` (normalized: rounded up, at least 1).
 */
export function assertPoolOptions(
  owner: string,
  options: PoolLikeOptions | null | undefined
): void {
  assertConnectionOptions(owner, options);
  const poolSize = options ? normalizeConnectionOptions(options).poolSize : undefined;
  if (isSet(poolSize)) assertInteger(poolSize, `${owner}: poolSize`, { max: MAX_POOL_SIZE });
}

/** The number of connections a pool builds for valid `options`: default 4. */
export function resolvePoolSize(options: PoolLikeOptions | null | undefined): number {
  const poolSize = options ? normalizeConnectionOptions(options).poolSize : undefined;
  return isSet(poolSize) ? poolSize : 4;
}

/** Validated options, every missing, `undefined` or `null` value replaced by its default. */
export function resolveConnectionOptions(
  owner: string,
  input?: Partial<ConnectionOptions> | null
): Required<ConnectionOptions> {
  assertConnectionOptions(owner, input);
  const resolved: Required<ConnectionOptions> = { ...DEFAULT_CONNECTION };
  if (!input) return resolved;
  const options = normalizeConnectionOptions(input);
  for (const key of OPTION_KEYS) {
    const value = options[key];
    if (isSet(value)) (resolved as Record<string, unknown>)[key] = value;
  }
  return resolved;
}

type NumericKey = DurationKey | CountKey | 'port' | 'poolSize';

/** A count beyond exact integers: 2.9.10's comparisons never reached it, so no limit. */
const unlimited = (value: number): boolean => value > Number.MAX_SAFE_INTEGER;

/**
 * How 2.9.10 read each numeric option outside the validated range, where it had a
 * well-defined result: its comparisons are `pingInterval <= 0` (no ping),
 * `attempt > maxReconnectAttempts` (NaN never stops), `timeouts >= maxCommandTimeouts`
 * (with `<= 0` disabling it, and NaN never firing), `failures >= maxPingFailures`,
 * `inFlight < maxInFlight` and `i < poolSize` (with `poolSize` raised to 1). A count
 * above `Number.MAX_SAFE_INTEGER` is no limit (Infinity).
 */
const REWRITES: Partial<Record<NumericKey, (value: number) => number>> = {
  pingInterval: (value) => (value <= 0 ? 0 : value),
  maxReconnectAttempts: (value) =>
    Number.isNaN(value) || unlimited(value) ? Infinity : Math.max(0, Math.floor(value)),
  maxCommandTimeouts: (value) =>
    Number.isNaN(value) ? 0 : unlimited(value) ? Infinity : ceilAtLeast(value, 0),
  maxPingFailures: (value) =>
    unlimited(value) ? Infinity : isFiniteNumber(value) && value > 0 ? Math.ceil(value) : value,
  maxInFlight: (value) =>
    unlimited(value) ? Infinity : isFiniteNumber(value) && value > 0 ? Math.ceil(value) : value,
  poolSize: (value) => (value < 1 ? 1 : isFiniteNumber(value) ? Math.ceil(value) : value),
};

const NUMERIC_KEYS: readonly NumericKey[] = [
  ...(Object.keys(DURATIONS) as DurationKey[]),
  ...(Object.keys(COUNTS) as CountKey[]),
  'port',
  'poolSize',
];

/**
 * `options` with every value 2.9.10 accepted rewritten to the value it acted as: a
 * numeric string ("6789", as `process.env.PORT` gives it) is that number, the
 * `REWRITES` above apply, and a falsy non-string token (`false`, `0`) is no token, as
 * 2.9.10's `if (token)` skipped Auth. Anything else is left for validation to reject,
 * so 0 timeouts, NaN timers, an infinite pool, an empty host or a zero window still
 * throw. Returns `options` itself when nothing changes.
 */
export function normalizeConnectionOptions<T extends PoolLikeOptions>(options: T): T {
  let normalized: Record<string, unknown> | null = null;
  const token: unknown = options.token;
  if (isSet(token) && typeof token !== 'string' && !token) normalized = { ...options, token: '' };
  for (const key of NUMERIC_KEYS) {
    const raw = (options as Record<string, unknown>)[key];
    const coerced = coerceNumericString(raw);
    const rewrite = REWRITES[key];
    const value = typeof coerced === 'number' && rewrite ? rewrite(coerced) : coerced;
    if (Object.is(value, raw)) continue;
    normalized ??= { ...options };
    normalized[key] = value;
  }
  return (normalized ?? options) as T;
}

/** Whether an option is given: `undefined` and `null` both mean "use the default". */
function isSet<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}
