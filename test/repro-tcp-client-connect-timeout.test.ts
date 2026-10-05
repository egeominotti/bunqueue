import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import type { ConnectionOptions } from '../src/client/tcp/types';
import {
  cleanup,
  recordNativeTimers,
  startSilentServer,
  THIRTY_DAYS,
  track,
} from './tcp-client-support';

// Repro: `connectTimeout` reached a native setTimeout unvalidated. NaN, 0, Infinity, a
// value above 2^31 - 1 ms (30 days) or an explicit `undefined` (which replaced the
// default) ended every connection attempt after ~1 ms with "Connection timeout", so a
// client that needs more than a millisecond to connect (any TLS handshake, any remote
// broker) could never connect. A TLS client against a server that never answers the
// handshake stays connecting until the timeout, which makes the deadline observable.

afterEach(cleanup);

type Outcome = { threw: string } | { connect: string };

/** Start connecting with `options` and report the attempt's state after `ms`. */
async function connectWithin(options: Partial<ConnectionOptions>, ms: number): Promise<Outcome> {
  let client: TcpClient;
  try {
    client = track(
      new TcpClient({
        host: '127.0.0.1',
        port: startSilentServer().port,
        tls: { rejectUnauthorized: false },
        autoReconnect: false,
        pingInterval: 0,
        ...options,
      })
    );
  } catch (error) {
    return { threw: (error as Error).name };
  }
  const attempt = client.connect().then(
    () => 'connected',
    (error: Error) => error.message
  );
  return { connect: await Promise.race([attempt, Bun.sleep(ms).then(() => 'pending')]) };
}

test.each([
  ['NaN', Number.NaN],
  ['0', 0],
  ['Infinity', Number.POSITIVE_INFINITY],
])('connectTimeout %s throws at construction instead of failing after ~1 ms', async (_, value) => {
  expect(await connectWithin({ connectTimeout: value }, 100)).toEqual({ threw: 'RangeError' });
});

test.each([
  ['30 days', THIRTY_DAYS],
  ['undefined (the 5 s default)', undefined],
])('connectTimeout %s keeps a slow handshake connecting', async (_, value) => {
  const native = recordNativeTimers();
  expect(await connectWithin({ connectTimeout: value }, 100)).toEqual({ connect: 'pending' });
  expect(native.invalid).toEqual([]);
});

test('a short valid connectTimeout still ends the attempt', async () => {
  const outcome = await connectWithin({ connectTimeout: 30 }, 1_000);
  expect(outcome).toEqual({ connect: expect.stringContaining('Connection timeout') });
});
