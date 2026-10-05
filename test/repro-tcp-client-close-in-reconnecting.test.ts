import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import { ReconnectManager } from '../src/client/tcp/reconnect';
import { cleanup, startBroker, track, waitUntil } from './tcp-client-support';

// Repro: ReconnectManager emitted 'reconnecting' and only then armed its timer, so a
// close() from a 'reconnecting' listener cancelled nothing: the timer fired, connect()
// reopened the client and it reconnected although the application had closed it.

afterEach(cleanup);

test('close() inside a reconnecting listener stops the reconnect', async () => {
  const broker = startBroker();
  const client = track(
    new TcpClient({
      host: '127.0.0.1',
      port: broker.port,
      reconnectDelay: 5,
      maxReconnectDelay: 5,
      pingInterval: 0,
    })
  );
  await client.connect();
  await waitUntil(() => broker.open() === 1, 1_000); // the broker's open runs after the client's
  let connects = 0;
  client.on('connected', () => connects++);
  client.once('reconnecting', () => client.close());

  broker.kick(); // the broker drops the connection: the client schedules a reconnect
  await Bun.sleep(150);

  expect({
    state: client.getState(),
    connected: client.isConnected(),
    connects,
    accepted: broker.accepted(),
  }).toEqual({ state: 'closed', connected: false, connects: 0, accepted: 1 });
});

test('ReconnectManager: setClosed(true) from a reconnecting listener cancels the retry', async () => {
  const manager = new ReconnectManager({
    maxReconnectAttempts: Number.POSITIVE_INFINITY,
    reconnectDelay: 1,
    maxReconnectDelay: 1,
    autoReconnect: true,
  });
  let retries = 0;
  manager.once('reconnecting', () => manager.setClosed(true));
  const scheduled = manager.scheduleReconnect(async () => {
    retries++;
  });
  await Bun.sleep(30);
  expect({ scheduled, retries }).toEqual({ scheduled: false, retries: 0 });
});
