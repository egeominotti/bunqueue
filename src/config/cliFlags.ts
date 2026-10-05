/**
 * `bunqueue start` flag values. A numeric flag follows exactly the rule of its env
 * var and config-file key (`SETTINGS`): a value `parseInt` misread stops startup with
 * an error naming the flag, while the port flags keep 2.9.10's warning and default
 * for a value that is not a port (see `src/cli/commands/server.ts`).
 */

import { readEnvInteger } from '../shared/durations';
import { ConfigError, parseWholeFlag, type WholeRule } from './numbers';
import type { NumericSetting } from './settings';

/** Parse a numeric flag: `Invalid --tcp-port: "abc" (expected a whole number ...)`. */
export function parseNumericFlag(
  setting: NumericSetting & { readonly flag: string },
  raw: string | boolean
): number {
  return parseWholeFlag(setting.flag, raw, setting.rule);
}

/**
 * A string flag value. `parseArgs` yields `true` for a flag given without a value
 * (`--data-path` at the end of the line); that, or an empty value, is an error.
 */
export function requireFlagValue(flag: string, raw: string | boolean): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError([`Invalid ${flag}: missing value`]);
  }
  return raw;
}

/**
 * A port flag of `bunqueue start` as 2.9.10 read it: a valid port is returned, and a
 * value that is not a port (no number, out of range, no value) returns undefined so the
 * caller can warn and fall back, as 2.9.10 did. A value `parseInt` misread (`1e4`, read
 * as port 1; `6789abc`) still throws a `ConfigError` naming the flag.
 */
export function parsePortFlagLeniently(
  flag: string,
  raw: string | boolean,
  rule: WholeRule
): number | undefined {
  if (typeof raw === 'string' && readEnvInteger(raw).kind === 'misread') {
    return parseWholeFlag(flag, raw, rule);
  }
  try {
    return parseWholeFlag(flag, raw, rule);
  } catch {
    return undefined;
  }
}

/** How a flag value is shown in a warning: quoted, or `(missing value)`. */
export function shownFlagValue(raw: string | boolean): string {
  return typeof raw === 'string' ? JSON.stringify(raw) : '(missing value)';
}
