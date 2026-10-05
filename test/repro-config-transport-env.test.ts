/**
 * Repro: TCP_IDLE_TIMEOUT_MS, TCP_MAX_WRITE_QUEUE_BYTES and RATE_LIMIT_* were validated
 * only when the TCP/HTTP servers were created, after storage had opened and the startup
 * banner had been printed. A bad value printed the banner, then
 * `Failed to start server: Invalid ...`.
 *
 * They are now validated by resolveServerConfig with the other settings: one
 * `Fatal error:` line, nothing printed or bound before it. The lazy runtime accessors
 * (rateLimiterEnvConfig, tcpIdleTimeoutMs, tcpMaxWriteQueueBytes) keep the same rules
 * and messages for embedded and programmatic users.
 *
 * Also here: `bunqueue-mcp` printed the stringified error object
 * (`Fatal error: Error: ...`, `Fatal error: ConfigError: ...`) instead of the message.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveServerConfig } from '../src/config';
import { makeSandbox, outcome, REPO, runChild, runServer, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const sandboxes: Array<ReturnType<typeof makeSandbox>> = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

// RATE_LIMIT_CLEANUP_MS=0 and RATE_LIMIT_WINDOW_MS=0 started 2.9.10: no longer errors
// (see test/repro-compat-config-env-numbers.test.ts); a misread still is.
const CASES: Array<[string, string, string]> = [
  ['TCP_IDLE_TIMEOUT_MS', '1e12', 'a whole number of milliseconds >= 0'],
  ['TCP_MAX_WRITE_QUEUE_BYTES', '64MB', 'a whole number of bytes >= 0'],
  ['RATE_LIMIT_WINDOW_MS', '1m', '0 or a whole number of milliseconds >= 1'],
  ['RATE_LIMIT_MAX_REQUESTS', '0', 'a whole number of requests >= 1'],
  ['RATE_LIMIT_CLEANUP_MS', '1e12', 'a whole number of milliseconds >= 1'],
];

describe('resolveServerConfig validates the transport env vars', () => {
  test.each(CASES)('%s=%p', (name, raw, expected) => {
    env.set({ [name]: raw });
    expect(outcome(() => resolveServerConfig(null))).toEqual({
      error: `Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected})`,
    });
  });

  test('valid values (0 disables the TCP limits) still start', () => {
    env.set({
      TCP_IDLE_TIMEOUT_MS: '0',
      TCP_MAX_WRITE_QUEUE_BYTES: '0',
      RATE_LIMIT_MAX_REQUESTS: '5',
    });
    expect('value' in outcome(() => resolveServerConfig(null))).toBe(true);
  });
});

test('a bad transport env var prints one Fatal error line before the banner', async () => {
  const results = await Promise.all(
    CASES.map(async ([name, raw, expected]) => {
      const box = makeSandbox('bunqueue-transport-env-');
      sandboxes.push(box);
      const run = await runServer(box, { env: { [name]: raw }, killAfterMs: 4_000 });
      return {
        name,
        exitCode: run.exitCode,
        output: run.output.trim(),
        expected: `Fatal error: Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected})`,
      };
    })
  );
  expect(results.map(({ name, exitCode, output }) => ({ name, exitCode, output }))).toEqual(
    results.map(({ name, expected }) => ({ name, exitCode: 1, output: expected }))
  );
}, 20_000);

describe('bunqueue-mcp prints the error message, not the error object', () => {
  async function mcp(vars: Record<string, string>) {
    const box = makeSandbox('bunqueue-mcp-message-');
    sandboxes.push(box);
    return runChild([join(REPO, 'src/mcp/index.ts')], {
      cwd: box.dir,
      killAfterMs: 10_000,
      env: { BUNQUEUE_MODE: 'embedded', BUNQUEUE_DATA_PATH: box.dataPath, ...vars },
    });
  }

  test('a plain Error', async () => {
    const run = await mcp({ BUNQUEUE_MCP_TRANSPORT: 'websocket' });
    expect({ exitCode: run.exitCode, output: run.output.trim() }).toEqual({
      exitCode: 1,
      output: 'Fatal error: BUNQUEUE_MCP_TRANSPORT must be stdio or http (got "websocket")',
    });
  }, 15_000);

  test('a ConfigError', async () => {
    const run = await mcp({
      BUNQUEUE_CLOUD_URL: 'https://cloud.example',
      BUNQUEUE_CLOUD_API_KEY: 'key',
      BUNQUEUE_CLOUD_INSTANCE_ID: 'instance-1',
      BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD: '0',
    });
    expect({ exitCode: run.exitCode, output: run.output.trim() }).toEqual({
      exitCode: 1,
      output:
        'Fatal error: Invalid BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD: "0" (expected a whole number >= 1)',
    });
  }, 15_000);
});
