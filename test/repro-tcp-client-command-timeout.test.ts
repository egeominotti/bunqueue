import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import type { ConnectionOptions, SendOptions } from '../src/client/tcp/types';
import { cleanup, recordNativeTimers, startBroker, THIRTY_DAYS, track } from './tcp-client-support';

// Repro: every command arms a native setTimeout with its own `timeout` (positive and
// finite, no upper bound) or the connection's unvalidated `commandTimeout`. NaN, 0, a
// value above 2^31 - 1 ms (30 days), Infinity or an explicit `undefined` (which
// replaced the default) made every command, the token's Auth included, fail with
// "Command timeout" after ~1 ms, and three of those forced a reconnect. maxInFlight 0
// or an explicit `undefined` left every command queued until its timeout.

afterEach(cleanup);

type Outcome = { threw: string } | { reply: string };

/** Connect a client built with `options` and send Hold, which the broker answers after `holdMs`. */
async function holdOutcome(
  options: Partial<ConnectionOptions>,
  holdMs: number,
  send?: SendOptions,
  authDelayMs?: number
): Promise<Outcome> {
  const broker = startBroker({ authDelayMs });
  let client: TcpClient;
  try {
    client = track(
      new TcpClient({
        host: '127.0.0.1',
        port: broker.port,
        autoReconnect: false,
        pingInterval: 0,
        ...options,
      })
    );
  } catch (error) {
    return { threw: (error as Error).name };
  }
  try {
    await client.connect();
    const response = await client.send({ cmd: 'Hold', ms: holdMs }, send);
    return { reply: response.ok === true ? 'ok' : 'error' };
  } catch (error) {
    return { reply: (error as Error).message };
  }
}

test.each([
  ['commandTimeout NaN', { commandTimeout: Number.NaN }],
  ['commandTimeout 0', { commandTimeout: 0 }],
  ['maxInFlight 0', { commandTimeout: 300, maxInFlight: 0 }],
])('%s throws at construction instead of failing every command', async (_, options) => {
  expect(await holdOutcome(options, 30)).toEqual({ threw: 'RangeError' });
});

test.each([
  ['commandTimeout 30 days', { commandTimeout: THIRTY_DAYS }],
  ['commandTimeout Infinity (never)', { commandTimeout: Number.POSITIVE_INFINITY }],
  ['commandTimeout undefined (the 30 s default)', { commandTimeout: undefined }],
  ['maxInFlight undefined (the default 100)', { commandTimeout: 300, maxInFlight: undefined }],
])('with %s a command answered after 30 ms succeeds', async (_, options) => {
  const native = recordNativeTimers();
  expect(await holdOutcome(options, 30)).toEqual({ reply: 'ok' });
  expect(native.invalid).toEqual([]);
});

test('a per-command timeout of 30 days outlives a 200 ms commandTimeout', async () => {
  const native = recordNativeTimers();
  const outcome = await holdOutcome({ commandTimeout: 200 }, 300, { timeout: THIRTY_DAYS });
  expect(outcome).toEqual({ reply: 'ok' });
  expect(native.invalid).toEqual([]);
});

test('the Auth sent with a token honours a 30-day commandTimeout', async () => {
  const native = recordNativeTimers();
  const outcome = await holdOutcome(
    { token: 'secret', commandTimeout: THIRTY_DAYS },
    0,
    undefined,
    30
  );
  expect(outcome).toEqual({ reply: 'ok' });
  expect(native.invalid).toEqual([]);
});

test('a short valid commandTimeout still times a command out', async () => {
  expect(await holdOutcome({ commandTimeout: 50 }, 400)).toEqual({ reply: 'Command timeout' });
});
