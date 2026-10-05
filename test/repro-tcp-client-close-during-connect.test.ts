import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import { cleanup, startBroker, track, waitUntil } from './tcp-client-support';

// Repro: close() while connect() was in flight did not win. The attempt finished
// after close(): getState() said 'closed' while isConnected() was true, the socket
// stayed open on the broker, the health ping ran, and a second connect() that waited
// for the first resolved with the closed client. With a token, close() during Auth
// threw a TypeError inside the attempt (it ended a socket close() had already nulled).

afterEach(cleanup);

interface Outcome {
  attempt: string;
  waiter: string;
  state: string;
  connected: boolean;
  openOnBroker: number;
  pings: number;
}

/** Start connect() twice, close() after `closeAfterMs`, and report what is left. */
async function closeDuringConnect(token: string, closeAfterMs: number): Promise<Outcome> {
  const broker = startBroker({ authDelayMs: 150 });
  const client = track(
    new TcpClient({ host: '127.0.0.1', port: broker.port, token, pingInterval: 20 })
  );
  const settle = (promise: Promise<void>) =>
    promise.then(
      () => 'resolved',
      (error: Error) => `${error.name}: ${error.message}`
    );
  const attempt = settle(client.connect());
  const waiter = settle(client.connect());
  if (closeAfterMs > 0) await Bun.sleep(closeAfterMs);
  client.close();
  const outcome = { attempt: await attempt, waiter: await waiter };
  // The TCP connect was issued before close(): wait for the broker to see it come and go.
  await waitUntil(() => broker.accepted() === 1 && broker.open() === 0, 1_000);
  await Bun.sleep(60); // a running health ping would send a Ping here
  return {
    ...outcome,
    state: client.getState(),
    connected: client.isConnected(),
    openOnBroker: broker.open(),
    pings: broker.count('Ping'),
  };
}

const CLOSED = {
  attempt: 'ClientClosedError: Client closed',
  waiter: 'ClientClosedError: Client closed',
  state: 'closed',
  connected: false,
  openOnBroker: 0,
  pings: 0,
};

test('close() before the socket opens wins over the attempt', async () => {
  expect(await closeDuringConnect('', 0)).toEqual(CLOSED);
});

test('close() while Auth is in flight wins over the attempt', async () => {
  expect(await closeDuringConnect('secret', 50)).toEqual(CLOSED);
});

test('a later connect() after close() opens a fresh connection', async () => {
  const broker = startBroker();
  const client = track(new TcpClient({ host: '127.0.0.1', port: broker.port, pingInterval: 0 }));
  const first = client.connect().catch(() => undefined);
  client.close();
  await first;
  await client.connect();
  expect((await client.send({ cmd: 'Ping' })).ok).toBe(true);
  expect(client.getState()).toBe('connected');
  expect(await waitUntil(() => broker.open() === 1, 300)).toBe(true);
});
