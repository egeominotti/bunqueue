/**
 * Boundary validation for durations (milliseconds).
 *
 * A duration that reaches a timer as NaN, Infinity or a negative number is rewritten
 * by the runtime to about 1 ms (see `timers.ts`), so a typo in an option or an env
 * var silently becomes a hot loop. These helpers reject such values where they enter:
 * `assertDuration` for public client options and method arguments, `assertInteger` for
 * the counts and limits next to them (attempts, slots, pool sizes), and
 * `parseIntegerEnv` / `parseDurationEnv` for server env vars, which fail fast at startup
 * as the rest of the server configuration does. The env grammar accepts every form
 * `parseInt` read as the operator meant (`+6789`, `6789.0`, `5000ms`, `60000 # comment`)
 * and refuses the forms it misread (`30s`, `1e3`). `describeValue` formats the received
 * value in every message. `parseIntegerEnv` is the shared whole-number env parser (the
 * server config reaches it through `src/config/numbers.ts`), but not the only one: some
 * modules still parse their own, e.g. the MCP HTTP settings in `src/mcp/transportConfig.ts`.
 * See docs/features/shared-timers.md.
 */

/** Limits for `assertDuration`. */
export interface DurationOptions {
  /** Smallest accepted value, inclusive. Default 0. */
  min?: number;
  /** Largest accepted finite value, inclusive. Default unbounded. */
  max?: number;
  /** Accept Infinity (meaning "never"), whatever `max` is. Default false. */
  allowInfinity?: boolean;
  /** Require a whole number of milliseconds. Default false. */
  integer?: boolean;
}

/** Limits for `assertInteger`. Values are always safe integers. */
export interface IntegerOptions {
  /** Smallest accepted value, inclusive. Default `Number.MIN_SAFE_INTEGER`. */
  min?: number;
  /** Largest accepted finite value, inclusive. Default `Number.MAX_SAFE_INTEGER`. */
  max?: number;
  /** Accept Infinity (meaning "no limit"), whatever `max` is. Default false. */
  allowInfinity?: boolean;
  /** Unit in the error message (`bytes`, `threads`); none when omitted. */
  unit?: string;
}

/** Limits for `parseDurationEnv`. Values are always whole milliseconds. */
export interface EnvDurationOptions {
  /** Smallest accepted value, inclusive. Default 0. */
  min?: number;
  /** Largest accepted value, inclusive. Default `Number.MAX_SAFE_INTEGER`. */
  max?: number;
  /** Accept 0 even when `min` is above it (0 commonly means "disabled"). Default false. */
  allowZero?: boolean;
}

/**
 * Limits for `parseIntegerEnv`: those of `parseDurationEnv`, the unit to print, and the
 * values the variable tolerated before 2.9.11, each kept with a warning.
 */
export interface EnvIntegerOptions extends EnvDurationOptions {
  /** Unit in the error message (`requests`, `bytes`, `milliseconds`); none when omitted. */
  unit?: string;
  /**
   * Unit suffixes accepted after the number, in any case (`5000ms`, `512 MB`). Default:
   * `ms` when `unit` is milliseconds, `mb` when it is megabytes, none otherwise.
   */
  suffixes?: readonly string[];
  /**
   * The variable used to be read with `Number()`, not `parseInt`: accept exactly what
   * `Number()` reads as a whole number (`1e5`, `0x10`) and nothing else.
   */
  numberSyntax?: boolean;
  /**
   * Used instead, with a warning, for a value holding no number (`abc`, `"6789"`) or a
   * whole number below `min`: where the variable used to fall back the same way.
   */
  invalid?: number;
  /**
   * Used instead, with a warning, for a value holding no number only (takes precedence
   * over `invalid`); `Infinity` means "no limit".
   */
  unreadable?: number;
  /** Used instead, with a warning, for a negative whole number (`-1` meaning "off"). */
  negative?: number;
  /** Receives the warning when `invalid` or `negative` is used; dropped without it. */
  warn?: (message: string) => void;
}

/** How an env value reads: a whole number as written, no number at all, or a misread. */
export type EnvIntegerReading =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'misread' };

/**
 * Return `value` when it is an acceptable duration, otherwise throw.
 *
 * Throws TypeError for a non-number and RangeError for NaN, an infinity (unless
 * `allowInfinity`), a fraction (with `integer`) or a value outside [min, max]. The
 * message names the option and the received value, e.g.
 * `Worker: heartbeatInterval must be a finite number of milliseconds >= 0 (got NaN)`.
 */
export function assertDuration(value: unknown, name: string, opts: DurationOptions = {}): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be ${expected(opts)} (got ${describeValue(value)})`);
  }
  if (value === Infinity && opts.allowInfinity) return value;
  const min = opts.min ?? 0;
  const max = opts.max ?? Infinity;
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (opts.integer === true && !Number.isInteger(value))
  ) {
    throw new RangeError(`${name} must be ${expected(opts)} (got ${describeValue(value)})`);
  }
  return value;
}

/**
 * Return `value` when it is a safe integer (a count or a limit, not a duration) within
 * [min, max], or Infinity with `allowInfinity`; otherwise throw.
 *
 * Throws TypeError for a non-number and RangeError for NaN, a fraction, an infinity
 * (unless `allowInfinity`), an integer beyond `Number.MAX_SAFE_INTEGER` (`2 ** 53 + 1`
 * equals `2 ** 53`, so a bound or a counter there is not exact) or a value outside
 * [min, max]. The message names the option and the received value, e.g.
 * `TcpClient: maxInFlight must be a whole number >= 1 or Infinity (got 0)`.
 */
export function assertInteger(value: unknown, name: string, opts: IntegerOptions = {}): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be ${expectedInteger(opts)} (got ${describeValue(value)})`);
  }
  if (value === Infinity && opts.allowInfinity) return value;
  if (
    !Number.isSafeInteger(value) ||
    (opts.min !== undefined && value < opts.min) ||
    (opts.max !== undefined && value > opts.max)
  ) {
    const unsafe = Number.isInteger(value) && !Number.isSafeInteger(value);
    const shown = `${describeValue(value)}${unsafe ? ', not a safe integer' : ''}`;
    throw new RangeError(`${name} must be ${expectedInteger(opts)} (got ${shown})`);
  }
  return value;
}

/**
 * The grammar `parseInt` read as the operator meant: an optional sign, digits, an optional
 * decimal fraction (dropped, as `parseInt` dropped it: `1500.5` is 1500), an optional unit
 * word and an optional trailing `# comment` (a Docker `--env-file` line keeps it).
 * Everything else `parseInt` reads is a misread (`1e3`, `1.5e3`, `30s`, `6789abc`).
 */
const WRITTEN = /^([+-]?\d+)(?:\.\d*)?(?:\s*([a-z]+))?(?:\s*#.*)?$/i;

function defaultSuffixes(unit: string | undefined): readonly string[] {
  if (unit === 'milliseconds') return ['ms'];
  if (unit === 'megabytes') return ['mb'];
  return [];
}

/**
 * Classify an env value (already known to be non-empty): `number` when it is a whole
 * number as written (`+6789`, `6789.0`, `1500.5` read as 1500, `5000ms`,
 * `60000 # 1 minute`), `misread` when
 * `parseInt` would read a different number from it (`30s` -> 30, `1e3` -> 1,
 * `6789abc`), `invalid` when it holds no number at all (`abc`, `"6789"`). With
 * `numberSyntax` only what `Number()` reads as a whole number counts, and nothing is a
 * misread.
 */
export function readEnvInteger(
  raw: string,
  opts: Pick<EnvIntegerOptions, 'unit' | 'suffixes' | 'numberSyntax'> = {}
): EnvIntegerReading {
  const text = raw.trim();
  if (opts.numberSyntax === true) {
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isInteger(value) ? { kind: 'number', value: value + 0 } : { kind: 'invalid' };
  }
  const match = WRITTEN.exec(text);
  const suffixes = opts.suffixes ?? defaultSuffixes(opts.unit);
  if (match !== null && (match[2] === undefined || suffixes.includes(match[2].toLowerCase()))) {
    return { kind: 'number', value: Number(match[1]) + 0 };
  }
  return Number.isNaN(Number.parseInt(text, 10)) ? { kind: 'invalid' } : { kind: 'misread' };
}

/**
 * Parse a whole-number env var (a count, a size, a port or a duration). `undefined` or
 * `''` returns `fallback` as given. Otherwise the value must read as a whole number
 * (`readEnvInteger`: `+6789`, `6789.0`, `5000ms`, `60000 # 1 minute`) that is a safe
 * integer within the limits, or this throws an Error naming the variable and the value,
 * e.g. `Invalid RATE_LIMIT_MAX_REQUESTS: "1e4" (expected a whole number of requests >= 1)`.
 * A value `parseInt` would misread (`1e12` -> 1, `30s` -> 30) is always refused. The
 * `invalid` / `negative` options keep a value the variable used to tolerate, with a
 * warning (`-1` meaning "off", an unreadable value meaning the default).
 */
export function parseIntegerEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts: EnvIntegerOptions = {}
): number {
  if (raw === undefined || raw === '') return fallback;
  const reading = readEnvInteger(raw, opts);
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const tolerate = (value: number): number => {
    const used = value === Infinity ? 'no limit' : String(value);
    opts.warn?.(
      `Invalid ${name}: ${JSON.stringify(raw)} (expected ${expectedEnv(opts)}); using ${used}`
    );
    return value;
  };
  if (reading.kind === 'number' && Number.isSafeInteger(reading.value)) {
    const { value } = reading;
    if (value === 0 && opts.allowZero === true) return 0;
    if (value >= min && value <= max) return value;
    if (value < 0 && opts.negative !== undefined) return tolerate(opts.negative);
    if (value < min && opts.invalid !== undefined) return tolerate(opts.invalid);
  }
  if (reading.kind === 'invalid') {
    const replacement = opts.unreadable ?? opts.invalid;
    if (replacement !== undefined) return tolerate(replacement);
  }
  throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected ${expectedEnv(opts)})`);
}

/**
 * Parse a duration env var: `parseIntegerEnv` in milliseconds (an `ms` suffix is
 * accepted), e.g.
 * `Invalid STATS_INTERVAL_MS: "abc" (expected a whole number of milliseconds >= 0)`.
 * Values above the runtime timer limit are valid: the timer helpers honour them.
 */
export function parseDurationEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts: Omit<EnvIntegerOptions, 'unit'> = {}
): number {
  return parseIntegerEnv(name, raw, fallback, { ...opts, unit: 'milliseconds' });
}

function range(min: number, max: number | undefined): string {
  return max === undefined || max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
}

function expected(opts: DurationOptions): string {
  const kind = opts.integer === true ? 'a whole number' : 'a finite number';
  const infinity = opts.allowInfinity === true ? ' or Infinity' : '';
  return `${kind} of milliseconds ${range(opts.min ?? 0, opts.max)}${infinity}`;
}

function expectedInteger(opts: IntegerOptions): string {
  const { min, max } = opts;
  const bound =
    min !== undefined && max !== undefined
      ? ` between ${min} and ${max}`
      : min !== undefined
        ? ` >= ${min}`
        : max !== undefined
          ? ` <= ${max}`
          : '';
  const unit = opts.unit === undefined ? '' : ` of ${opts.unit}`;
  return `a whole number${unit}${bound}${opts.allowInfinity === true ? ' or Infinity' : ''}`;
}

function expectedEnv(opts: EnvIntegerOptions): string {
  const min = opts.min ?? 0;
  const zero = opts.allowZero === true && min > 0 ? '0 or ' : '';
  const unit = opts.unit === undefined ? '' : ` of ${opts.unit}`;
  return `${zero}a whole number${unit} ${range(min, opts.max)}`;
}

/**
 * How a received value is shown in a validation message: strings quoted, `-0` kept,
 * objects summarized (`an object`, `an array`), never their contents.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  if (typeof value === 'function') return 'a function';
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}
