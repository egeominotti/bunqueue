/**
 * Log level and format of the server, with the precedence of 2.9.10.
 *
 * Two places apply them: the bare entry point (`src/main.ts`, the Docker image) applies
 * LOG_LEVEL / LOG_FORMAT on its first line, then `bootServer` applies the value resolved
 * here. That value comes from the config file when it sets the key, else from the env,
 * so a file `logging.level` wins over LOG_LEVEL, and LOG_LEVEL is not even read then.
 * `bootServer` only ever turns JSON on, never off: LOG_FORMAT=json applied by the entry
 * point stays on even when the file says `text`, as in 2.9.10. A word that names no
 * level is a warning and leaves the level untouched (`logLevel: undefined`), as 2.9.10
 * ignored it; an unknown format is a warning and means text.
 */

import { describeValue } from '../shared/durations';
import type { ConfigIssues, Env } from './numbers';
import { LOG_FORMATS, LOG_LEVELS, logFormatWord, logLevelWord, type LogFormat } from './text';
import type { LogLevelWord } from './text';

export interface ResolvedLogging {
  /** The level to apply, or undefined to keep the current one (an unknown word). */
  readonly logLevel: LogLevelWord | undefined;
  /** `json` turns JSON output on; `text` leaves the output mode as it is. */
  readonly logFormat: LogFormat;
}

const LEVELS = LOG_LEVELS.join(', ');
const FORMATS = LOG_FORMATS.join(', ');

/** Resolve the logging settings; unknown words are recorded as warnings in `issues`. */
export function resolveLogging(
  file: { readonly level?: unknown; readonly format?: unknown } | undefined,
  env: Env,
  issues: ConfigIssues
): ResolvedLogging {
  let logLevel: LogLevelWord | undefined = 'info';
  if (file?.level !== undefined) {
    logLevel = logLevelWord(file.level);
    if (logLevel === undefined) {
      issues.warn(
        `logging.level must be one of ${LEVELS} (got ${describeValue(file.level)}); ignored`
      );
    }
  } else if (env.LOG_LEVEL) {
    logLevel = logLevelWord(env.LOG_LEVEL);
    if (logLevel === undefined) {
      issues.warn(
        `Invalid LOG_LEVEL: ${JSON.stringify(env.LOG_LEVEL)} (expected one of ${LEVELS}); ignored`
      );
    }
  }

  let logFormat: LogFormat = 'text';
  if (file?.format !== undefined) {
    logFormat = logFormatWord(file.format) ?? 'text';
    if (logFormatWord(file.format) === undefined) {
      issues.warn(
        `logging.format must be one of ${FORMATS} (got ${describeValue(file.format)}); using text`
      );
    }
  } else if (env.LOG_FORMAT) {
    logFormat = logFormatWord(env.LOG_FORMAT) ?? 'text';
    if (logFormatWord(env.LOG_FORMAT) === undefined) {
      issues.warn(
        `Invalid LOG_FORMAT: ${JSON.stringify(env.LOG_FORMAT)} (expected one of ${FORMATS}); using text`
      );
    }
  }
  return { logLevel, logFormat };
}
