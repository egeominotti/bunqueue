import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import { ReconnectManager, type ReconnectConfig } from '../src/client/tcp/reconnect';
import type { ConnectionOptions } from '../src/client/tcp/types';
import { cleanup, closedPort, recordNativeTimers, THIRTY_DAYS, track } from './tcp-client-support';

// Repro: the reconnect delay is min(reconnectDelay * 2^(n-1), maxReconnectDelay) plus up
// to 30% jitter, armed with a native setTimeout and built from unvalidated options.
// NaN, 0 (which never backs off: 0 * 2^n = 0) or a delay above 2^31 - 1 ms made every
// retry fire after ~1 ms: a reconnect storm against a down broker, forever with the
// default maxReconnectAttempts (Infinity). Past attempt 1024 the doubling overflowed
// too: 0 * 2^1024 is NaN, and a huge ceiling plus jitter is Infinity.

afterEach(cleanup);

type Outcome = { threw: string } | { reconnects: number; firstDelay: number | undefined };

/** Start a client against a port nothing listens on and count its retries in `ms`. */
async function reconnectsWithin(options: Partial<ConnectionOptions>, ms: number): Promise<Outcome> {
  let client: TcpClient;
  try {
    client = track(
      new TcpClient({ host: '127.0.0.1', port: closedPort(), pingInterval: 0, ...options })
    );
  } catch (error) {
    return { threw: (error as Error).name };
  }
  const delays: number[] = [];
  client.on('reconnecting', ({ delay }) => delays.push(delay));
  client.on('error', () => undefined);
  client.connect().catch(() => undefined);
  await Bun.sleep(ms);
  client.close();
  return { reconnects: delays.length, firstDelay: delays[0] };
}

test.each([
  ['reconnectDelay NaN', { reconnectDelay: Number.NaN }],
  ['maxReconnectDelay NaN', { maxReconnectDelay: Number.NaN }],
  ['reconnectDelay 0', { reconnectDelay: 0 }],
  ['maxReconnectDelay 0', { maxReconnectDelay: 0 }],
])('%s throws at construction instead of retrying every ~1 ms', async (_, options) => {
  expect(await reconnectsWithin(options, 150)).toEqual({ threw: 'RangeError' });
});

test('a 30-day backoff schedules one retry and waits for it', async () => {
  const native = recordNativeTimers();
  const outcome = await reconnectsWithin(
    { reconnectDelay: THIRTY_DAYS, maxReconnectDelay: THIRTY_DAYS },
    150
  );
  expect(outcome).toEqual({ reconnects: 1, firstDelay: expect.any(Number) });
  expect((outcome as { firstDelay: number }).firstDelay).toBeGreaterThanOrEqual(THIRTY_DAYS);
  expect(native.invalid).toEqual([]);
});

/** The delays of `attempts` consecutive scheduled (and cancelled) reconnects. */
function backoffDelays(config: Partial<ReconnectConfig>, attempts: number): number[] {
  const manager = new ReconnectManager({
    maxReconnectAttempts: Number.POSITIVE_INFINITY,
    reconnectDelay: 100,
    maxReconnectDelay: 30_000,
    autoReconnect: true,
    ...config,
  });
  const delays: number[] = [];
  manager.on('reconnecting', ({ delay }) => delays.push(delay));
  for (let attempt = 0; attempt < attempts; attempt++) {
    manager.scheduleReconnect(async () => undefined);
    manager.cancelReconnect();
  }
  return delays;
}

test.each([
  ['a zero base', { reconnectDelay: 0 }],
  ['a ceiling near Number.MAX_VALUE', { reconnectDelay: 1, maxReconnectDelay: Number.MAX_VALUE }],
])('the backoff stays finite past attempt 1024 with %s', (_, config) => {
  const native = recordNativeTimers();
  const delays = backoffDelays(config, 1_100);
  expect(delays).toHaveLength(1_100);
  expect(delays.filter((delay) => !Number.isFinite(delay) || delay < 0)).toEqual([]);
  expect(native.invalid).toEqual([]);
});

test('the backoff still doubles from the base up to the ceiling, plus at most 30%', () => {
  const delays = backoffDelays({ reconnectDelay: 100, maxReconnectDelay: 1_000 }, 8);
  const ceilings = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000];
  delays.forEach((delay, index) => {
    expect(delay).toBeGreaterThanOrEqual(ceilings[index]);
    expect(delay).toBeLessThanOrEqual(ceilings[index] * 1.3);
  });
});
