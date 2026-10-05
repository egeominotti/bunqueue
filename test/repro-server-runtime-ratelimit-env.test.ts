/**
 * Repro: the protocol rate limiter read RATE_LIMIT_* with a raw parseInt at import.
 *
 * - RATE_LIMIT_CLEANUP_MS `-1`, `1e12` (parseInt: 1) or a value above 2^31 - 1 made the
 *   cleanup interval spin; `0` or `abc` (NaN) skipped the `if (ms)` guard, so no sweep
 *   ever ran and the per-client map grew without bound (HTTP clients are never removed
 *   any other way). A misread (`1e12`) is refused; `-1`, `0` and `abc` started 2.9.10,
 *   so they keep the default sweep with a warning (upgrade compatibility).
 * - RATE_LIMIT_WINDOW_MS `abc` (NaN) never expired a timestamp: a client that reached
 *   the limit stayed blocked forever. (`0` disabled rate limiting, and still does.)
 * - RATE_LIMIT_MAX_REQUESTS `abc` (NaN) silently disabled the limit; `0` refused every
 *   request; `1e4` (parseInt: 1) allowed one request per window. `abc` keeps the limit
 *   disabled, now with a warning (2.9.10 ran that way: upgrade compatibility).
 * - A bad value now fails server creation instead of surfacing on the first request.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO, TIMER_WARNING, runChild } from './server-runtime-support';

setDefaultTimeout(60_000);

/** Count the global limiter's cleanup sweeps for 250 ms. */
const SWEEP_PROBE = `
  const limiterModule = await import('${REPO}/src/infrastructure/server/rateLimiter.ts');
  let sweeps = 0;
  const proto = limiterModule.ProtocolRateLimiter.prototype as unknown as { cleanup(): void };
  const sweep = proto.cleanup;
  proto.cleanup = function (this: unknown) {
    sweeps++;
    sweep.call(this);
  };
  limiterModule.getRateLimiter();
  await Bun.sleep(250);
  limiterModule.stopRateLimiter();
  report({ sweeps });
`;

/** One request, a pause longer than a sane window, then another request. */
const WINDOW_PROBE = `
  const { ProtocolRateLimiter } = await import('${REPO}/src/infrastructure/server/rateLimiter.ts');
  const limiter = new ProtocolRateLimiter({ cleanupIntervalMs: 0 });
  const first = limiter.isAllowed('client');
  const second = limiter.isAllowed('client');
  await Bun.sleep(60);
  const later = limiter.isAllowed('client');
  limiter.stop();
  report({ first, second, later });
`;

/** Create the TCP server as bootstrap does; report whether creation succeeded. */
const SERVER_PROBE = `
  const { QueueManager } = await import('${REPO}/src/application/queueManager.ts');
  const { createTcpServer } = await import('${REPO}/src/infrastructure/server/tcp.ts');
  const { createHttpServer } = await import('${REPO}/src/infrastructure/server/http.ts');
  const manager = new QueueManager();
  const created: string[] = [];
  const errors: string[] = [];
  try {
    createTcpServer(manager, { hostname: '127.0.0.1', port: 0 }).stop();
    created.push('tcp');
  } catch (error) {
    errors.push((error as Error).message);
  }
  try {
    createHttpServer(manager, { hostname: '127.0.0.1', port: 0 }).stop();
    created.push('http');
  } catch (error) {
    errors.push((error as Error).message);
  }
  manager.shutdown();
  report({ created, errors });
`;

const expectedError = (name: string, raw: string, expected: string) => ({
  ok: false,
  name: 'Error',
  error: `Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected})`,
});

describe('RATE_LIMIT_CLEANUP_MS', () => {
  test('a misread value (parseInt: 1 ms, a spin) is rejected', async () => {
    const result = await runChild(SWEEP_PROBE, { RATE_LIMIT_CLEANUP_MS: '1e12' });
    expect(result.report).toEqual(
      expectedError('RATE_LIMIT_CLEANUP_MS', '1e12', 'a whole number of milliseconds >= 1')
    );
  });

  test('values that spun or disabled the sweep keep the default sweep with a warning', async () => {
    const raws = ['-1', '0', 'abc'];
    const results = await Promise.all(
      raws.map((raw) => runChild(SWEEP_PROBE, { RATE_LIMIT_CLEANUP_MS: raw }))
    );
    for (const [index, raw] of raws.entries()) {
      // The default 60 s sweep does not run within the 250 ms probe: no spin.
      expect(results[index].report).toEqual({ ok: true, sweeps: 0 });
      expect(results[index].output).toContain(
        `Invalid RATE_LIMIT_CLEANUP_MS: ${JSON.stringify(raw)}`
      );
    }
  });

  test('a period above the native timer limit is honoured, not turned into a spin', async () => {
    const result = await runChild(SWEEP_PROBE, { RATE_LIMIT_CLEANUP_MS: '99999999999' });
    expect(result.report).toEqual({ ok: true, sweeps: 0 });
    expect(result.output).not.toMatch(TIMER_WARNING);
  });
});

describe('RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS', () => {
  test('a NaN window, which blocked a client forever, is rejected', async () => {
    const result = await runChild(WINDOW_PROBE, {
      RATE_LIMIT_WINDOW_MS: 'abc',
      RATE_LIMIT_MAX_REQUESTS: '1',
    });
    expect(result.report).toEqual(
      expectedError('RATE_LIMIT_WINDOW_MS', 'abc', '0 or a whole number of milliseconds >= 1')
    );
  });

  test('a valid window still expires: the client is allowed again after it', async () => {
    const result = await runChild(WINDOW_PROBE, {
      RATE_LIMIT_WINDOW_MS: '20',
      RATE_LIMIT_MAX_REQUESTS: '1',
    });
    expect(result.report).toEqual({ ok: true, first: true, second: false, later: true });
  });

  test('request limits that refused everything or were misread are rejected', async () => {
    const raws = ['0', '1e4', '-1', '10k'];
    const results = await Promise.all(
      raws.map((raw) => runChild(WINDOW_PROBE, { RATE_LIMIT_MAX_REQUESTS: raw }))
    );
    for (const [index, raw] of raws.entries()) {
      expect(results[index].report).toEqual(
        expectedError('RATE_LIMIT_MAX_REQUESTS', raw, 'a whole number of requests >= 1')
      );
    }
  });
});

test('a request limit without a number disables the limiter with a warning', async () => {
  const result = await runChild(WINDOW_PROBE, { RATE_LIMIT_MAX_REQUESTS: 'abc' });
  expect(result.report).toEqual({ ok: true, first: true, second: true, later: true });
  expect(result.output).toContain('Invalid RATE_LIMIT_MAX_REQUESTS: "abc"');
});

describe('server startup', () => {
  test('a malformed limiter variable fails TCP and HTTP server creation, not the first request', async () => {
    const result = await runChild(SERVER_PROBE, { RATE_LIMIT_WINDOW_MS: '1m' });
    const message =
      'Invalid RATE_LIMIT_WINDOW_MS: "1m" (expected 0 or a whole number of milliseconds >= 1)';
    expect(result.report).toEqual({ ok: true, created: [], errors: [message, message] });
  });

  test('valid variables create both servers', async () => {
    const result = await runChild(SERVER_PROBE, {
      RATE_LIMIT_WINDOW_MS: '1000',
      RATE_LIMIT_MAX_REQUESTS: '50',
      RATE_LIMIT_CLEANUP_MS: '99999999999',
    });
    expect(result.report).toEqual({ ok: true, created: ['tcp', 'http'], errors: [] });
  });
});
