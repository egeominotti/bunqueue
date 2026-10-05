/**
 * Repro: the Cloud agent's numeric env vars were read with a raw `parseInt`, in two
 * diverging copies (`src/config/resolve.ts` for the server and
 * `src/infrastructure/cloud/config.ts` for `CloudAgent.create`, used by the MCP server).
 *
 * - `BUNQUEUE_CLOUD_BUFFER_SIZE=abc` (NaN): `items.length >= NaN` is always false, so
 *   the offline snapshot buffer grew without bound.
 * - `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD=abc` (NaN): `failures >= NaN` is never
 *   true, so the breaker never opened and a dead endpoint was hammered.
 * - `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS=abc` (NaN): an open breaker never reset.
 * - `BUNQUEUE_CLOUD_INTERVAL_MS` was parsed raw and never used (documented as the
 *   upload interval; the cadence is adaptive).
 *
 * Each must now be rejected with an error naming the variable, by both entry points,
 * when Cloud is configured. Without Cloud the settings are unused, and BUNQUEUE_CLOUD_
 * INTERVAL_MS is never applied: as on 2.9.10 they never stop startup, an invalid value
 * is a warning (upgrade compatibility, test/repro-compat-config-env-switches.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resolveCloudConfig, resolveServerConfig } from '../src/config/resolve';
import { loadCloudConfig } from '../src/infrastructure/cloud/config';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const ENABLED = {
  BUNQUEUE_CLOUD_URL: 'https://cloud.example',
  BUNQUEUE_CLOUD_API_KEY: 'key',
  BUNQUEUE_CLOUD_INSTANCE_ID: 'instance-1',
};

const CASES = [
  ['BUNQUEUE_CLOUD_BUFFER_SIZE', 'abc'],
  ['BUNQUEUE_CLOUD_BUFFER_SIZE', '0'],
  ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD', 'abc'],
  ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD', '0'],
  ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS', 'abc'],
  ['BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS', '1e3'],
] as const;

describe('numeric Cloud env vars (findings 5, 6)', () => {
  test.each(CASES)('server resolver rejects %s=%p', (name, raw) => {
    env.set({ ...ENABLED, [name]: raw });
    expect(outcome(() => resolveCloudConfig(null))).toEqual({
      error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
    });
  });

  test.each(CASES)('CloudAgent.create (MCP) path rejects %s=%p', (name, raw) => {
    env.set({ ...ENABLED, [name]: raw });
    expect(outcome(() => loadCloudConfig())).toEqual({
      error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
    });
  });

  test.each(CASES)('server startup rejects %s=%p when Cloud is configured', (name, raw) => {
    env.set({ ...ENABLED, [name]: raw });
    expect(outcome(() => resolveServerConfig(null))).toEqual({
      error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
    });
  });

  test.each([...CASES, ['BUNQUEUE_CLOUD_INTERVAL_MS', 'abc']])(
    'server startup warns about %s=%p without Cloud',
    (name, raw) => {
      env.set({ [name]: raw });
      expect(outcome(() => resolveServerConfig(null))).toEqual({
        value: expect.objectContaining({
          configWarnings: [expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`)],
        }),
      });
    }
  );

  test('BUNQUEUE_CLOUD_INTERVAL_MS (never applied) only warns, even with Cloud', () => {
    env.set({ ...ENABLED, BUNQUEUE_CLOUD_INTERVAL_MS: 'abc' });
    expect(outcome(() => loadCloudConfig())).toEqual({
      value: expect.objectContaining({ intervalMs: 15_000 }),
    });
    expect(outcome(() => resolveServerConfig(null))).toEqual({
      value: expect.objectContaining({
        configWarnings: [expect.stringContaining('Invalid BUNQUEUE_CLOUD_INTERVAL_MS: "abc"')],
      }),
    });
  });
});

test('both entry points resolve the same configuration (no drift)', () => {
  env.set({
    ...ENABLED,
    BUNQUEUE_CLOUD_BUFFER_SIZE: '100',
    BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD: '3',
    BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS: '30000',
    BUNQUEUE_CLOUD_INTERVAL_MS: '10000',
    BUNQUEUE_CLOUD_REDACT_FIELDS: 'email,password',
  });
  const fromAgent = loadCloudConfig('/data/q.db');
  expect(fromAgent).toEqual(resolveCloudConfig(null, '/data/q.db'));
  expect(fromAgent).toMatchObject({
    bufferSize: 100,
    circuitBreakerThreshold: 3,
    circuitBreakerResetMs: 30_000,
    intervalMs: 10_000,
    redactFields: ['email', 'password'],
  });
});
