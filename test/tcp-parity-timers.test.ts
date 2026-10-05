import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection as nativeConnection } from '../src/client/tcp/transport';
import { sleep as portableSleep } from '../sdk/typescript/src/canonical-transport/runtime';
import { createConnection as portableConnection } from '../sdk/typescript/src/canonical-transport/transport';
import { cleanup, startSilentServer, THIRTY_DAYS, waitUntil } from './tcp-client-support';

// Timers of the portable bunqueue-client runtime (sdk/typescript/src/canonical-transport),
// which replaces Bun's in the Node.js build. Before: the portable `sleep` (what
// `Bun.sleep` becomes) and the portable connect timeout were raw setTimeout calls, so a
// delay above 2^31 - 1 ms or Infinity ran after ~1 ms: a 30-day sleep returned at once
// and a 30-day connectTimeout failed every connection attempt. The native transport
// left the socket of a timed-out attempt open on the broker.

afterEach(cleanup);

type Settled = 'pending' | 'resolved' | `threw ${string}`;

/** How a sleep stands after `ms`: pending, resolved, or thrown synchronously. */
async function settledWithin(start: () => Promise<unknown>, ms: number): Promise<Settled> {
  let promise: Promise<unknown>;
  try {
    promise = start();
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
  return Promise.race([
    promise.then((): Settled => 'resolved'),
    Bun.sleep(ms).then((): Settled => 'pending'),
  ]);
}

describe('portable sleep matches Bun.sleep', () => {
  // Bun.sleep, observed on Bun 1.4.2: pending for a delay above 2^31 - 1 ms and for
  // Infinity; resolved at once for NaN, negative, -Infinity and sub-millisecond delays;
  // a synchronous TypeError for a non-number.
  test.each<[string, unknown, Settled]>([
    ['30 days', THIRTY_DAYS, 'pending'],
    ['Infinity', Number.POSITIVE_INFINITY, 'pending'],
    ['NaN', Number.NaN, 'resolved'],
    ['-1', -1, 'resolved'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'resolved'],
    ['0.5', 0.5, 'resolved'],
    ['0', 0, 'resolved'],
    ['"20"', '20', 'threw TypeError'],
    ['undefined', undefined, 'threw TypeError'],
  ])('sleep(%s) after 60 ms', async (_, value, expected) => {
    expect(await settledWithin(() => portableSleep(value as number), 60)).toBe(expected);
  });

  test('a finite sleep waits its full length', async () => {
    const started = performance.now();
    await portableSleep(25);
    expect(performance.now() - started).toBeGreaterThanOrEqual(24);
  });
});

describe.each([
  ['native', nativeConnection],
  ['portable', portableConnection],
] as const)('%s transport connect timeout', (_name, connect) => {
  /** A TLS attempt against a server that never answers the handshake. */
  function stalledAttempt(port: number, connectTimeout: number, events: string[]) {
    return connect(
      { host: '127.0.0.1', port, tls: { rejectUnauthorized: false } },
      connectTimeout,
      {
        onData: () => events.push('data'),
        onClose: () => events.push('close'),
        onError: (error) => events.push(`error:${error.message}`),
      }
    ).then(
      () => 'connected',
      (error: Error) => error.message.split(' to ')[0]
    );
  }

  test('a 30-day connectTimeout keeps a stalled handshake pending', async () => {
    const server = startSilentServer();
    const events: string[] = [];
    const attempt = stalledAttempt(server.port, THIRTY_DAYS, events);
    const state = await Promise.race([attempt, Bun.sleep(100).then(() => 'pending')]);
    expect({ state, events }).toEqual({ state: 'pending', events: [] });
  });

  test('a timed-out attempt closes its socket and reports one close', async () => {
    const server = startSilentServer();
    const events: string[] = [];
    const outcome = await stalledAttempt(server.port, 40, events);
    await waitUntil(() => server.open() === 0 && events.length > 0, 1_000);
    await Bun.sleep(50); // any duplicate close or late event would land here
    expect({ outcome, open: server.open(), events }).toEqual({
      outcome: 'Connection timeout',
      open: 0,
      events: ['close'],
    });
  });
});
