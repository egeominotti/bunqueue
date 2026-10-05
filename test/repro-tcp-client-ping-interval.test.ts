import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import type { ConnectionOptions } from '../src/client/tcp/types';
import { cleanup, recordNativeTimers, startBroker, THIRTY_DAYS, track } from './tcp-client-support';

// Repro: `pingInterval` reached `setInterval` behind a `<= 0` guard only. NaN, a
// sub-millisecond value, a value above 2^31 - 1 ms (30 days), Infinity, or an explicit
// `undefined` (which replaced the default) armed a ~1 ms interval, so every connected
// client (each pooled connection, QueueEvents, a Worker's stalled subscription) sent
// the broker hundreds of Pings per second. 0 disables the ping, as documented.

afterEach(cleanup);

type Outcome = { threw: string } | { pings: number };

/** Build a client with `options`, connect it, and count the Pings it sends in `ms`. */
async function pingsWithin(options: Partial<ConnectionOptions>, ms: number): Promise<Outcome> {
  const broker = startBroker();
  let client: TcpClient;
  try {
    client = track(
      new TcpClient({ host: '127.0.0.1', port: broker.port, autoReconnect: false, ...options })
    );
  } catch (error) {
    return { threw: (error as Error).name };
  }
  await client.connect();
  await Bun.sleep(ms);
  return { pings: broker.count('Ping') };
}

test.each([
  ['NaN', Number.NaN],
  ['0.5 ms', 0.5],
])('pingInterval %s throws at construction instead of pinging every ~1 ms', async (_, value) => {
  expect(await pingsWithin({ pingInterval: value }, 100)).toEqual({ threw: 'RangeError' });
});

test.each([
  ['30 days', THIRTY_DAYS],
  ['Infinity (never)', Number.POSITIVE_INFINITY],
  ['undefined (the 30 s default)', undefined],
  ['0 (disabled)', 0],
])('pingInterval %s sends no Ping in the first 150 ms', async (_, value) => {
  const native = recordNativeTimers();
  expect(await pingsWithin({ pingInterval: value }, 150)).toEqual({ pings: 0 });
  expect(native.invalid).toEqual([]);
});

test('a short valid pingInterval still pings', async () => {
  const outcome = await pingsWithin({ pingInterval: 25 }, 200);
  expect('pings' in outcome && outcome.pings).toBeGreaterThanOrEqual(2);
});
