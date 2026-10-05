/**
 * Whole-number server settings: one rule, three sources.
 *
 * A setting arrives as an env var string, a `bunqueue start` flag string or a
 * config-file value. Strings follow the env grammar of `parseIntegerEnv` in
 * `src/shared/durations.ts`: every form `parseInt` read as meant (`+6789`, `6789.0`,
 * `5000ms`, `60000 # comment`) is accepted, the forms it misread (`1e12`, `5s`) are
 * errors. Config-file values must be finite numbers within the rule; a fraction is
 * rounded down, as numeric config values always were. A setting may keep a value it
 * tolerated before 2.9.11 (`LegacyTolerance`): then a warning, not an error. This
 * module has no other dependency, so application modules (webhooks, monitoring) can
 * import it without pulling in the server config.
 */

import { assertDuration, describeValue, parseIntegerEnv } from '../shared/durations';

/** Env-like source: `Bun.env`, `process.env` or a plain object in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

export type WholeUnit = 'milliseconds' | 'megabytes' | 'bytes' | 'requests';

/** The accepted range of one numeric setting. */
export interface WholeRule {
  /** Unit printed in errors; `milliseconds` delegates to the shared duration helpers. */
  readonly unit?: WholeUnit;
  /** Smallest accepted value, inclusive. */
  readonly min: number;
  /** Largest accepted value, inclusive. Default `Number.MAX_SAFE_INTEGER`. */
  readonly max?: number;
  /** Accept 0 even when `min` is above it (0 means "disabled"). */
  readonly allowZero?: boolean;
}

/**
 * Values a setting tolerated before 2.9.11, kept with a warning instead of stopping
 * startup: `invalid` replaces a value holding no number or below the minimum (2.9.10
 * fell back to its default), `unreadable` a value holding no number only (`Infinity`:
 * no limit), `negative` a negative one (`-1` meaning "off").
 */
export interface LegacyTolerance {
  readonly invalid?: number;
  readonly unreadable?: number;
  readonly negative?: number;
}

/**
 * Every problem found while resolving the configuration, reported together. The entry
 * points print it as one `Fatal error: <message>` line (no stack): it is the operator's
 * input that is wrong, not the code.
 */
export class ConfigError extends Error {
  /** Each problem on its own; the message already lists them (non-enumerable, not printed twice). */
  declare readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? problems[0]
        : `Invalid server configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`
    );
    this.name = 'ConfigError';
    Object.defineProperty(this, 'problems', { value: problems, enumerable: false });
  }
}

/** Collects errors and warnings so one startup reports all of them. */
export class ConfigIssues {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  /** Errors of settings whose feature may be off, settled by `settle` (see `forFeature`). */
  private readonly pending = new Map<string, string[]>();

  /** Return `parse()`, or record the error it throws and return `fallback`. */
  check<T>(parse: () => T, fallback: T): T {
    try {
      return parse();
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
      return fallback;
    }
  }

  error(message: string): void {
    this.errors.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /**
   * A view for the settings of one feature (PostgreSQL, Cloud, S3 backup): its warnings
   * are recorded here, its errors are held until `settle` (or `take`) decides whether
   * they stop startup. A setting of a feature that is off must never stop it.
   */
  forFeature(feature: string): ConfigIssues {
    const view = new ConfigIssues();
    const held = this.pending.get(feature) ?? [];
    this.pending.set(feature, held);
    view.error = (message) => held.push(message);
    view.warn = (message) => this.warn(message);
    return view;
  }

  /** The held errors of `feature`, removed from this collector. */
  take(feature: string): string[] {
    const held = this.pending.get(feature) ?? [];
    this.pending.delete(feature);
    return held;
  }

  /** Record the held errors of `feature`: as errors when it is `active`, else as warnings. */
  settle(feature: string, active: boolean, note: string): void {
    for (const message of this.take(feature)) {
      if (active) this.error(message);
      else this.warn(`${message}; ignored: ${note}`);
    }
  }

  /** Throw one `ConfigError` listing every recorded error. */
  throwIfAny(): void {
    if (this.errors.length > 0) throw new ConfigError([...this.errors]);
  }
}

/**
 * Parse an env var: `undefined` or `''` returns `fallback`; anything else must read as a
 * whole number within the rule (the env grammar of `parseIntegerEnv`), or this throws
 * `Invalid NAME: "raw" (expected a whole number >= 1)`, unless `legacy` tolerates the
 * value: then `warn` receives the warning and the tolerated value is returned.
 */
export function parseWholeEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  rule: WholeRule,
  legacy: LegacyTolerance & { warn?: (message: string) => void } = {}
): number {
  return parseIntegerEnv(name, raw, fallback, {
    min: rule.min,
    max: rule.max,
    unit: rule.unit,
    allowZero: rule.allowZero,
    ...legacy,
  });
}

/**
 * Parse a `bunqueue start` flag with the same grammar as an env var, strictly (no legacy
 * tolerance). A flag given without a value (`parseArgs` yields `true`) or with an empty
 * one is an error; callers that treat `--flag=` as "not given" check for `''` first.
 */
export function parseWholeFlag(flag: string, raw: string | boolean, rule: WholeRule): number {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError([`Invalid ${flag}: missing value (expected ${expectedText(rule)})`]);
  }
  try {
    return parseWholeEnv(flag, raw, Number.NaN, rule);
  } catch (error) {
    throw new ConfigError([error instanceof Error ? error.message : String(error)]);
  }
}

/**
 * Validate a config-file number: finite and within the rule, rounded down to a whole
 * number. Throws `storage.maxCompletedJobs must be a finite number >= 1 (got 0)`.
 */
export function assertWhole(value: unknown, name: string, rule: WholeRule): number {
  if (rule.allowZero === true && value === 0) return 0;
  if (rule.unit === 'milliseconds') {
    const checked = assertDuration(value, name, { min: rule.min, max: rule.max });
    const whole = Math.floor(checked);
    if (!Number.isSafeInteger(whole)) {
      throw new RangeError(`${name} must be at most ${Number.MAX_SAFE_INTEGER} (got ${checked})`);
    }
    return whole;
  }
  const valid =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    ((rule.allowZero === true && value === 0) || (value >= rule.min && value <= maxOf(rule)));
  if (!valid) {
    const message = `${name} must be a finite number${unitText(rule)} ${rangeText(rule)} (got ${describeValue(value)})`;
    throw typeof value === 'number' ? new RangeError(message) : new TypeError(message);
  }
  return Math.floor(value);
}

/** `a whole number of milliseconds >= 1000`, as the env errors word it. */
export function expectedText(rule: WholeRule): string {
  return `a whole number${unitText(rule)} ${rangeText(rule)}`;
}

function maxOf(rule: WholeRule): number {
  return rule.max ?? Number.MAX_SAFE_INTEGER;
}

function unitText(rule: WholeRule): string {
  return rule.unit === undefined ? '' : ` of ${rule.unit}`;
}

function rangeText(rule: WholeRule): string {
  return rule.max === undefined ? `>= ${rule.min}` : `between ${rule.min} and ${rule.max}`;
}
