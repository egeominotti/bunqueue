/**
 * Repro (upgrade compatibility, review findings): four more inputs whose 2.9.10 result
 * the 2.9.11 candidate changed.
 *
 * - `bunqueue start --tcp-port abc` / `70000` / `-5` (and `--http-port`): 2.9.10 printed
 *   `Warning: Invalid TCP port "abc". Using default 6789.` and started on 6789/6790; the
 *   candidate stopped startup. Global `-p abc` on `start` was dropped with a warning
 *   (the server then used TCP_PORT or 6789). A misread (`1e4`, read as 1) stays an error.
 * - Config-file booleans given as strings: 2.9.10 used JS truthiness, so
 *   `backup.enabled: 'false'` kept backups on and `requireAuthForMetrics: 'false'` kept
 *   /prometheus protected. The candidate read them as false (backups off, metrics
 *   public). Any non-empty string is true again, `''` false, with a warning.
 * - Metrics auth on without any auth token answers 503 on /prometheus, as in 2.9.10;
 *   the server now says so at startup.
 * - A decimal fraction in a numeric env var (`SHUTDOWN_TIMEOUT_MS=1500.5`): 2.9.10's
 *   `parseInt` read 1500; the candidate stopped startup.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { parseCliFlags } from '../src/cli/commands/server';
import { resolveServerConfig, type ResolvedConfig } from '../src/config/resolve';
import { parseIntegerEnv } from '../src/shared/durations';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

/** Run `fn` with console.warn captured; returns its outcome and the warnings. */
function warned<T>(fn: () => T): { result: ReturnType<typeof outcome<T>>; warnings: string[] } {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return { result: outcome(fn), warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
  }
}

function resolved(file: unknown, vars: Record<string, string | undefined> = {}): ResolvedConfig {
  const result = outcome(() => resolveServerConfig(file as never, vars));
  if ('error' in result) throw new Error(`unexpected startup error: ${result.error}`);
  return result.value;
}

describe('bunqueue start port flags', () => {
  test.each([
    ['--tcp-port', 'abc', 'tcpPort', 6789],
    ['--tcp-port', '70000', 'tcpPort', 6789],
    ['--tcp-port', '-5', 'tcpPort', 6789],
    ['--http-port', 'abc', 'httpPort', 6790],
    ['--http-port', '99999', 'httpPort', 6790],
  ] as const)('%s %p warns and uses the default, as 2.9.10 did', (flag, raw, key, port) => {
    const { result, warnings } = warned(() => parseCliFlags([flag, raw]));
    expect(result).toEqual({ value: expect.objectContaining({ [key]: port }) });
    expect(warnings).toEqual([expect.stringContaining(`"${raw}"`)]);
  });

  test('--tcp-port 0 binds an OS port; 6789.5 reads 6789; a misread stays an error', () => {
    expect(warned(() => parseCliFlags(['--tcp-port', '0'])).result).toEqual({
      value: expect.objectContaining({ tcpPort: 0 }),
    });
    expect(warned(() => parseCliFlags(['--tcp-port', '6789.5'])).result).toEqual({
      value: expect.objectContaining({ tcpPort: 6789 }),
    });
    expect(warned(() => parseCliFlags(['--tcp-port', '1e4'])).result).toEqual({
      error: expect.stringContaining('Invalid --tcp-port: "1e4"'),
    });
  });

  test('global -p abc on start is dropped with a warning (the server port applies)', () => {
    env.set({ TCP_PORT: undefined, BUNQUEUE_TCP_PORT: undefined, BQ_TCP_PORT: undefined });
    const { result, warnings } = warned(() => parseGlobalOptions(['start', '-p', 'abc']));
    expect(result).toMatchObject({ value: { commandArgs: ['start'] } });
    expect(warnings).toEqual([expect.stringContaining('"abc"')]);
    expect(warned(() => parseGlobalOptions(['start', '--port', '1e4'])).result).toEqual({
      error: expect.stringContaining('Invalid --port: "1e4"'),
    });
  });
});

describe('config-file booleans given as strings keep their 2.9.10 truthiness', () => {
  const CREDS = { bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };

  test.each([
    ['false', true],
    ['0', true],
    ['true', true],
    ['', false],
  ])('backup.enabled %p is %p, with a warning', (raw, enabled) => {
    const file = { storage: { dataPath: '/tmp/x.db' }, backup: { enabled: raw, ...CREDS } };
    const config = resolved(file);
    expect(config.s3BackupEnabled).toBe(enabled);
    expect(config.configWarnings.filter((w) => w.includes('backup.enabled')).length).toBe(1);
  });

  test("requireAuthForMetrics 'false' keeps /prometheus protected; real booleans do not warn", () => {
    const config = resolved({ auth: { tokens: ['t'], requireAuthForMetrics: 'false' } });
    expect(config.requireAuthForMetrics).toBe(true);
    expect(config.configWarnings).toEqual([expect.stringContaining('auth.requireAuthForMetrics')]);
    const real = resolved({ auth: { tokens: ['t'], requireAuthForMetrics: false } });
    expect({ value: real.requireAuthForMetrics, warnings: real.configWarnings }).toEqual({
      value: false,
      warnings: [],
    });
  });
});

describe('metrics auth without tokens', () => {
  test('is reported at startup (/prometheus answers 503, as in 2.9.10)', () => {
    for (const [file, vars, source] of [
      [null, { METRICS_AUTH: 'true' }, 'METRICS_AUTH'],
      [{ auth: { requireAuthForMetrics: true } }, {}, 'auth.requireAuthForMetrics'],
    ] as const) {
      const config = resolved(file, vars);
      expect(config.configWarnings).toEqual([expect.stringMatching(new RegExp(`${source}.*503`))]);
    }
    expect(resolved(null, { METRICS_AUTH: 'true', AUTH_TOKENS: 't' }).configWarnings).toEqual([]);
  });
});

describe('decimal fractions in numeric env vars are truncated, as parseInt did', () => {
  test('SHUTDOWN_TIMEOUT_MS=1500.5 is 1500; TCP_PORT=6789.9 is 6789', () => {
    expect(resolved(null, { SHUTDOWN_TIMEOUT_MS: '1500.5' }).shutdownTimeoutMs).toBe(1500);
    expect(resolved(null, { TCP_PORT: '6789.9' }).tcpPort).toBe(6789);
    expect(parseIntegerEnv('X', '5.75ms', 0, { unit: 'milliseconds' })).toBe(5);
  });

  test('misreads stay errors', () => {
    for (const raw of ['1.5e3', '30s', '6789abc', '.5']) {
      expect(() => parseIntegerEnv('X', raw, 0)).toThrow(`Invalid X: ${JSON.stringify(raw)}`);
    }
  });
});
