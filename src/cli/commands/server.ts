/**
 * Server Command Handler
 * Parses `bunqueue start` flags and boots the SAME full server as the bare
 * `bunqueue` entry point (shared bootstrap — S3 backup, cloud agent, stats,
 * crash handlers and graceful shutdown included).
 */

import { parseArgs } from 'node:util';
import { printServerHelp } from '../help';
import { loadConfigFile, resolveServerConfig } from '../../config';
import type { BunqueueConfig } from '../../config';
import { parseTokenList } from '../../config/auth';
import { parsePortFlagLeniently, requireFlagValue, shownFlagValue } from '../../config/cliFlags';
import { ConfigError } from '../../config/numbers';
import { SETTINGS } from '../../config/settings';
import { bootServer } from '../../infrastructure/server/bootstrap';

/** Server start options (CLI flags only — merged with config file later) */
interface CliFlags {
  tcpPort?: number;
  httpPort?: number;
  host?: string;
  dataPath?: string;
  authTokens?: string[];
  configPath?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  maxCompletedJobs?: number;
  completedRetentionMs?: number;
}

/**
 * Validate a port flag with the rule of TCP_PORT / server.tcpPort (0..65535, 0 lets the
 * OS pick; `+6789` and `6789.5` read as `parseInt` did). A value that is not a port
 * (`abc`, `70000`, `-5`, no value) prints 2.9.10's warning and uses the default port, as
 * 2.9.10 did; a misread (`1e4`, read as port 1) stops startup naming the flag.
 */
function validatePort(
  value: string | boolean,
  setting: typeof SETTINGS.tcpPort | typeof SETTINGS.httpPort,
  label: string
): number {
  const port = parsePortFlagLeniently(setting.flag, value, setting.rule);
  if (port !== undefined) return port;
  console.warn(
    `Warning: Invalid ${label} ${shownFlagValue(value)} (${setting.flag}: expected a whole number between 0 and 65535). Using default ${setting.fallback}.`
  );
  return setting.fallback;
}

/**
 * `--max-completed-jobs` / `--completed-retention-ms`, read with `Number()` as 2.9.10
 * did (`1e5` is 100000). A value that is not a whole number >= `min` is ignored with
 * 2.9.10's warning, and the file or env value applies; a flag without a value (`Number(
 * true)` used to be 1) is an error.
 */
function storageFlag(
  flag: string,
  label: string,
  raw: string | boolean,
  min: number
): number | undefined {
  if (typeof raw !== 'string') {
    throw new ConfigError([`Invalid ${flag}: missing value (expected a whole number >= ${min})`]);
  }
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(value) && value >= min) return value;
  console.warn(
    `Warning: Invalid ${label} "${raw}" (${flag}: expected a whole number >= ${min}). Ignoring it.`
  );
  return undefined;
}

/** Parse CLI flags (without env var fallback — that happens in resolveServerConfig) */
export function parseCliFlags(args: string[]): CliFlags {
  const { values } = parseArgs({
    args,
    options: {
      'tcp-port': { type: 'string' },
      'http-port': { type: 'string' },
      host: { type: 'string' },
      'data-path': { type: 'string' },
      'auth-tokens': { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'max-completed-jobs': { type: 'string' },
      'completed-retention-ms': { type: 'string' },
      config: { type: 'string', short: 'c' },
    },
    allowPositionals: false,
    strict: false,
  });

  // A flag given without a value parses as `true`; every helper below rejects it. An
  // empty value (`--tcp-port=`) means "not given", as in 2.9.10, except for the flags
  // whose empty value would silently open other data or weaken security (`--data-path`,
  // `--auth-tokens`, `--tls-cert`, `--tls-key`).
  const value = (name: string): string | boolean | undefined =>
    values[name] as string | boolean | undefined;
  const given = (name: string): string | boolean | undefined =>
    value(name) === '' ? undefined : value(name);
  const text = (name: string): string | undefined => {
    const raw = value(name);
    return raw === undefined ? undefined : requireFlagValue(`--${name}`, raw);
  };
  const flags: CliFlags = {};
  const tcpPort = given('tcp-port');
  if (tcpPort !== undefined) flags.tcpPort = validatePort(tcpPort, SETTINGS.tcpPort, 'TCP port');
  const httpPort = given('http-port');
  if (httpPort !== undefined) {
    flags.httpPort = validatePort(httpPort, SETTINGS.httpPort, 'HTTP port');
  }
  const host = given('host');
  if (host !== undefined) flags.host = requireFlagValue('--host', host);
  flags.dataPath = text('data-path');
  // The AUTH_TOKENS rule: trimmed, stray commas dropped, no token at all is an error
  // (`--auth-tokens ,` used to yield [] and silently replace AUTH_TOKENS: auth off).
  const authTokens = text('auth-tokens');
  if (authTokens !== undefined) flags.authTokens = parseTokenList('--auth-tokens', authTokens);
  flags.tlsCertFile = text('tls-cert');
  flags.tlsKeyFile = text('tls-key');
  const maxCompleted = given('max-completed-jobs');
  if (maxCompleted !== undefined) {
    const min = SETTINGS.maxCompletedJobs.rule.min;
    flags.maxCompletedJobs = storageFlag(
      '--max-completed-jobs',
      'completed-job cache limit',
      maxCompleted,
      min
    );
  }
  const retention = given('completed-retention-ms');
  if (retention !== undefined) {
    const min = SETTINGS.completedRetentionMs.rule.min;
    flags.completedRetentionMs = storageFlag(
      '--completed-retention-ms',
      'completed-job retention',
      retention,
      min
    );
  }
  const config = given('config');
  if (config !== undefined) flags.configPath = requireFlagValue('--config', config);
  return flags;
}

/** Merge CLI flags on top of config file (CLI wins) */
function applyCliFlags(fileConfig: BunqueueConfig | null, flags: CliFlags): BunqueueConfig | null {
  // No flags and no file config — nothing to merge
  const hasFlags =
    flags.tcpPort !== undefined ||
    flags.httpPort !== undefined ||
    flags.host !== undefined ||
    flags.dataPath !== undefined ||
    flags.authTokens !== undefined ||
    flags.maxCompletedJobs !== undefined ||
    flags.completedRetentionMs !== undefined ||
    flags.tlsCertFile !== undefined ||
    flags.tlsKeyFile !== undefined;
  if (!hasFlags && !fileConfig) return null;

  const base: BunqueueConfig = fileConfig ?? {};
  return {
    ...base,
    server: {
      ...base.server,
      ...(flags.tcpPort !== undefined && { tcpPort: flags.tcpPort }),
      ...(flags.httpPort !== undefined && { httpPort: flags.httpPort }),
      ...(flags.host !== undefined && { host: flags.host }),
      ...(flags.tlsCertFile !== undefined && { tlsCertFile: flags.tlsCertFile }),
      ...(flags.tlsKeyFile !== undefined && { tlsKeyFile: flags.tlsKeyFile }),
    },
    storage: {
      ...base.storage,
      ...(flags.dataPath !== undefined && { dataPath: flags.dataPath }),
      ...(flags.maxCompletedJobs !== undefined && {
        maxCompletedJobs: flags.maxCompletedJobs,
      }),
      ...(flags.completedRetentionMs !== undefined && {
        completedRetentionMs: flags.completedRetentionMs,
      }),
    },
    auth: {
      ...base.auth,
      ...(flags.authTokens !== undefined && { tokens: flags.authTokens }),
    },
  };
}

/** Run the server */
export async function runServer(args: string[], showHelp: boolean): Promise<void> {
  if (showHelp) {
    printServerHelp();
    process.exit(0);
  }

  const flags = parseCliFlags(args);

  // Load config file (bunqueue.config.ts), then overlay CLI flags
  const fileConfig = await loadConfigFile(flags.configPath);
  const mergedConfig = applyCliFlags(fileConfig, flags);
  const config = resolveServerConfig(mergedConfig);

  // Same full server as the bare `bunqueue` entry (shared bootstrap)
  await bootServer(mergedConfig, config);
}
