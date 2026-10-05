/**
 * bunqueue Cloud agent configuration: config file > env vars, validated. This is the
 * single source for the server (`bootServer`) and `CloudAgent.create` (the MCP
 * server), via `loadCloudConfig`. The Cloud numbers only stop startup when Cloud is
 * configured; BUNQUEUE_CLOUD_INTERVAL_MS never does (it is not applied).
 */

import { hostname } from 'os';
import type { CloudConfig } from '../infrastructure/cloud/types';
import { ConfigIssues, type Env } from './numbers';
import { normalizeConfigSection } from './schema';
import { SETTINGS, envNumber } from './settings';
import { envBoolean } from './text';
import type { BunqueueConfig } from './types';

/**
 * The numeric Cloud settings; problems are recorded in `issues`, in the `cloud` feature
 * bucket (they only stop startup when Cloud is configured, see `ConfigIssues.settle`).
 * `intervalMs` is read but never applied: the upload cadence is adaptive (5-30 s by
 * compressed snapshot size, `CloudAgent.computeInterval`), so an invalid value is only
 * ever a warning (bucket `cloudInterval`).
 */
export function cloudNumbers(
  env: Env,
  issues: ConfigIssues
): Pick<
  CloudConfig,
  'intervalMs' | 'bufferSize' | 'circuitBreakerThreshold' | 'circuitBreakerResetMs'
> {
  const cloud = issues.forFeature('cloud');
  return {
    intervalMs: envNumber(SETTINGS.cloudIntervalMs, env, issues.forFeature('cloudInterval')),
    bufferSize: envNumber(SETTINGS.cloudBufferSize, env, cloud),
    circuitBreakerThreshold: envNumber(SETTINGS.cloudCircuitBreakerThreshold, env, cloud),
    circuitBreakerResetMs: envNumber(SETTINGS.cloudCircuitBreakerResetMs, env, cloud),
  };
}

/**
 * The Cloud switches, all on by default. Every boolean word is honoured (only `false`
 * used to turn one off, so `BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` left remote control
 * enabled); any other word keeps the switch on, as before, with a warning.
 */
export function cloudSwitches(
  env: Env,
  issues: ConfigIssues
): Pick<CloudConfig, 'includeJobData' | 'useWebSocket' | 'useHttp' | 'remoteCommands'> {
  return {
    includeJobData: envBoolean('BUNQUEUE_CLOUD_INCLUDE_JOB_DATA', env, true, issues),
    useWebSocket: envBoolean('BUNQUEUE_CLOUD_USE_WEBSOCKET', env, true, issues),
    useHttp: envBoolean('BUNQUEUE_CLOUD_USE_HTTP', env, true, issues),
    remoteCommands: envBoolean('BUNQUEUE_CLOUD_REMOTE_COMMANDS', env, true, issues),
  };
}

/** Where Cloud mode would connect: the URL, API key and instance ID (file > env). */
export function cloudIdentity(
  fc: BunqueueConfig['cloud'] | undefined,
  env: Env
): { url?: string; apiKey?: string; instanceId?: string } {
  return {
    url: fc?.url ?? env.BUNQUEUE_CLOUD_URL,
    apiKey: fc?.apiKey ?? env.BUNQUEUE_CLOUD_API_KEY,
    instanceId: fc?.instanceId ?? env.BUNQUEUE_CLOUD_INSTANCE_ID,
  };
}

function list(raw: string | undefined): string[] {
  return raw?.split(',').filter(Boolean) ?? [];
}

/**
 * Resolve the Cloud config. Returns null when Cloud mode is off (no URL or API key,
 * or no instance ID, which is logged); throws a `ConfigError` on an invalid value.
 */
export function resolveCloudConfig(
  fileConfig: BunqueueConfig | null,
  dataPath?: string,
  env: Env = Bun.env
): CloudConfig | null {
  const issues = new ConfigIssues();
  const fc = normalizeConfigSection(fileConfig, 'cloud', issues);
  issues.throwIfAny();
  const { url, apiKey, instanceId } = cloudIdentity(fc, env);
  if (!url || !apiKey) return null;

  if (!instanceId) {
    console.error('[Cloud] BUNQUEUE_CLOUD_INSTANCE_ID is required for cloud mode.');
    return null;
  }
  // Warnings (unknown switch words, the unused interval) are reported by the server's
  // startup check (`resolveServerConfig`); here only errors matter.
  const numbers = cloudNumbers(env, issues);
  const switches = cloudSwitches(env, issues);
  issues.settle('cloud', true, '');
  issues.take('cloudInterval');
  issues.throwIfAny();

  return {
    url: url.replace(/\/+$/, ''),
    apiKey,
    instanceId,
    signingSecret: env.BUNQUEUE_CLOUD_SIGNING_SECRET ?? null,
    instanceName: env.BUNQUEUE_CLOUD_INSTANCE_NAME ?? hostname(),
    ...numbers,
    ...switches,
    redactFields: list(env.BUNQUEUE_CLOUD_REDACT_FIELDS),
    eventFilter: list(env.BUNQUEUE_CLOUD_EVENTS),
    dataPath: dataPath ?? null,
  };
}
