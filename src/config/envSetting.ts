/**
 * The shape of one numeric server setting (see `settings.ts`, the table of all of them)
 * and how its env value is read: the env var that supplies it (`envSource`, with the
 * `??` precedence of earlier releases) and the validated value (`envNumber`).
 */

import { readEnvInteger } from '../shared/durations';
import {
  expectedText,
  parseWholeEnv,
  type ConfigIssues,
  type Env,
  type LegacyTolerance,
  type WholeRule,
} from './numbers';

/** A feature whose settings only matter while it is in use (see `ConfigIssues.forFeature`). */
export type SettingFeature = 'postgres' | 'cloud' | 'cloudInterval';

/** One numeric setting and the sources it may come from. */
export interface NumericSetting {
  /** Env vars in priority order: the canonical name first, then legacy aliases. */
  readonly env: readonly string[];
  /** Config-file key path (`section.key`), when the file can set it. */
  readonly file?: string;
  /** `bunqueue start` flag, when one exists. */
  readonly flag?: string;
  readonly rule: WholeRule;
  /** Value when no source sets it; absent for an optional setting (null = off). */
  readonly fallback?: number;
  /** What 2.9.10 did with a value outside the rule: kept with a warning. Absent = error. */
  readonly legacy?: LegacyTolerance;
  /** The config-file key also takes a numeric string (2.9.10 coerced it where it was used). */
  readonly fileStrings?: boolean;
  /** Errors only stop startup while this feature is in use; otherwise they are warnings. */
  readonly feature?: SettingFeature;
}

/**
 * The env var that supplies `setting`, resolved like `a ?? b`: the first one that is
 * defined, even when empty (an empty canonical variable means the default, its legacy
 * aliases are not read), else the canonical name with no value.
 */
export function envSource(
  setting: NumericSetting,
  env: Env
): [name: string, raw: string | undefined] {
  const name = setting.env.find((candidate) => env[candidate] !== undefined);
  return name === undefined ? [setting.env[0], undefined] : [name, env[name]];
}

/**
 * The setting from env (or its fallback). An invalid value is recorded in `issues`, and
 * a value the setting tolerates (`legacy`) as a warning there.
 */
export function envNumber(
  setting: NumericSetting & { readonly fallback: number },
  env: Env,
  issues: ConfigIssues
): number {
  const [name, raw] = envSource(setting, env);
  const warn = (message: string) => issues.warn(message);
  return issues.check(
    () => parseWholeEnv(name, raw, setting.fallback, setting.rule, { ...setting.legacy, warn }),
    setting.fallback
  );
}

/**
 * An optional milliseconds setting (null = off): BUNQUEUE_COMPLETED_RETENTION_MS ??
 * COMPLETED_RETENTION_MS. Unset, empty or blank is null. 2.9.10 turned a negative or
 * unreadable value into "off" (`normalizeCompletedRetentionMs`); that stays, with a
 * warning. A value `parseInt` misread (`1e12` -> 1 ms, deleting every completed job on
 * the next sweep) is an error.
 */
export function envOptionalDuration(
  setting: NumericSetting,
  env: Env,
  issues: ConfigIssues
): number | null {
  const [name, raw] = envSource(setting, env);
  if (raw === undefined || raw.trim() === '') return null;
  const expected = `expected ${expectedText(setting.rule)}`;
  const reading = readEnvInteger(raw, { unit: setting.rule.unit });
  if (reading.kind === 'misread') {
    issues.error(`Invalid ${name}: ${JSON.stringify(raw)} (${expected})`);
    return null;
  }
  if (reading.kind === 'number' && Number.isSafeInteger(reading.value) && reading.value >= 0) {
    return reading.value;
  }
  issues.warn(`Invalid ${name}: ${JSON.stringify(raw)} (${expected}); the setting is off`);
  return null;
}
