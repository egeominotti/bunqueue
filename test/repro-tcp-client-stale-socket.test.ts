import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import { createConnection } from '../src/client/tcp/transport';
import { cleanup, startBroker, startSilentServer, track, waitUntil } from './tcp-client-support';
import { startGate, tlsMaterial } from './tcp-client-tls-support';

// Repro: an attempt rejected by connectTimeout never closed its socket, so every
// timed-out TLS attempt left a connection open on the broker. When the broker later
// closed it, its close event ran the client's lost-connection path against whatever
// connection was current: the healthy newer connection was dropped from the client
// (its socket leaked, still open), 'disconnected' fired and a third connection opened.

setDefaultTimeout(15_000);
afterEach(cleanup);

test('a timed-out attempt closes its socket', async () => {
  const server = startSilentServer();
  const results: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const outcome = await createConnection(
      { host: '127.0.0.1', port: server.port, tls: { rejectUnauthorized: false } },
      30,
      { onData: () => results.push('data'), onClose: () => undefined, onError: () => undefined }
    ).then(
      () => 'connected',
      (error: Error) => error.message.split(' to ')[0]
    );
    results.push(outcome);
  }
  await waitUntil(() => server.accepted() === 5 && server.open() === 0, 1_000);
  expect({ results, accepted: server.accepted(), open: server.open() }).toEqual({
    results: Array(5).fill('Connection timeout'),
    accepted: 5,
    open: 0,
  });
});

test("a timed-out socket's late close does not tear down the newer connection", async () => {
  const broker = startBroker({ tls: tlsMaterial() });
  const gate = startGate(broker.port, 1); // the first connection's handshake stalls
  const client = track(
    new TcpClient({
      host: '127.0.0.1',
      port: gate.port,
      tls: { rejectUnauthorized: false },
      connectTimeout: 100,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      pingInterval: 0,
    })
  );
  client.on('error', () => undefined);
  let disconnects = 0;
  client.on('disconnected', () => disconnects++);

  const first = await client.connect().then(
    () => 'connected',
    (error: Error) => error.message.split(' to ')[0]
  );
  const reconnected = await waitUntil(() => client.isConnected(), 3_000);
  await Bun.sleep(50);
  const openAfterReconnect = gate.open();

  gate.endStalled(); // the broker side closes the timed-out connection, if still open
  await Bun.sleep(150);
  const ping = await client.send({ cmd: 'Ping' }).then(
    (response) => response.ok === true,
    (error: Error) => error.message
  );

  expect({
    first,
    reconnected,
    openAfterReconnect,
    disconnects,
    accepted: gate.accepted(),
    open: gate.open(),
    ping,
  }).toEqual({
    first: 'Connection timeout',
    reconnected: true,
    openAfterReconnect: 1,
    disconnects: 0,
    accepted: 2,
    open: 1,
    ping: true,
  });
});
