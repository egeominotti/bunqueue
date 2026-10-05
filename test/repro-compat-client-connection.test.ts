/**
 * Repro (2.9.10 compatibility): connection options that 2.9.10 accepted with a
 * well-defined result must keep that result. The 2.9.11 candidate threw at
 * construction for them:
 *
 * - `port: process.env.PORT` (a numeric string) connected on 2.9.10, through Queue,
 *   Worker, FlowProducer, QueueEvents, getSharedPool and forward();
 * - a numeric string for any other numeric option read as that number;
 * - `poolSize: 2.5` built 3 connections (`i < 2.5`), `maxInFlight: 2.5` allowed 3
 *   commands in flight (`size < 2.5`), `maxCommandTimeouts: 2.5` reconnected on the 3rd
 *   (`>= 2.5`), `maxReconnectAttempts: 2.5` made 2 attempts (`attempt > 2.5` stops the
 *   3rd) and `-1` none, `maxCommandTimeouts: -1` disabled the counter (`max <= 0`);
 * - `pingInterval: -1` disabled the ping (`pingInterval <= 0`).
 *
 * Values 2.9.10 could not use (a hang, a reconnect storm, commands failing at once)
 * still throw, naming the class and the option.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FlowProducer, Queue, QueueEvents, Worker } from '../src/client';
import { resolveConnectionOptions } from '../src/client/tcp/options';
import { getPoolKey } from '../src/client/tcp/poolKey';
import { getSharedPool, releaseSharedPool, TcpConnectionPool } from '../src/client/tcpPool';
import { cleanup, closedPort, startBroker, track } from './tcp-client-support';

afterEach(cleanup);

const HOST = '127.0.0.1';
type PoolInternals = { options: Record<string, unknown>; clients: unknown[] };
const internals = (pool: TcpConnectionPool) => pool as unknown as PoolInternals;

describe('a numeric-string port (process.env.PORT) is a port', () => {
  test('TcpConnectionPool connects to it', async () => {
    const broker = startBroker();
    const pool = track(new TcpConnectionPool({ host: HOST, port: String(broker.port) }));
    const reply = await pool.send({ cmd: 'Ping' });
    expect(reply.ok).toBe(true);
    expect(broker.count('Ping')).toBe(1);
    expect(internals(pool).options.port).toBe(broker.port);
  });

  test('getSharedPool shares one pool between "6789" and 6789', () => {
    const port = closedPort();
    const fromString = getSharedPool({ host: HOST, port: ` ${port} ` as unknown as number });
    const fromNumber = getSharedPool({ host: HOST, port });
    try {
      expect(fromString).toBe(fromNumber);
      expect(getPoolKey({ host: HOST, port: String(port) as unknown as number })).toBe(
        getPoolKey({ host: HOST, port })
      );
    } finally {
      releaseSharedPool(fromString);
      releaseSharedPool(fromNumber);
    }
  });

  test('Queue, Worker, FlowProducer, QueueEvents and forward() accept it', async () => {
    const port = String(closedPort()) as unknown as number;
    const connection = { host: HOST, port };
    const queue = new Queue('compat-port', { embedded: false, connection });
    const worker = new Worker('compat-port', async () => 1, {
      embedded: false,
      autorun: false,
      connection,
    });
    const flow = new FlowProducer({ embedded: false, connection });
    const events = new QueueEvents('compat-port', { connection });
    const local = new Queue('compat-port-local', { embedded: true });
    const forwarder = local.forward({ to: connection });
    await forwarder.close();
    await local.close();
    await events.close();
    await flow.close();
    await worker.close(true);
    await queue.close();
  });

  test('the resolved options hold numbers', () => {
    const resolved = resolveConnectionOptions('TcpClient', {
      port: '6789' as unknown as number,
      commandTimeout: '15000' as unknown as number,
      pingInterval: '0' as unknown as number,
      maxInFlight: '50' as unknown as number,
    });
    expect(resolved.port).toBe(6789);
    expect(resolved.commandTimeout).toBe(15000);
    expect(resolved.pingInterval).toBe(0);
    expect(resolved.maxInFlight).toBe(50);
  });
});

describe('2.9.10 results of fractional and negative counts', () => {
  test('poolSize: "4" builds 4 connections and 2.5 builds 3, as on 2.9.10', () => {
    const four = track(
      new TcpConnectionPool({ host: HOST, port: closedPort(), poolSize: '4' as unknown as number })
    );
    const three = track(new TcpConnectionPool({ host: HOST, port: closedPort(), poolSize: 2.5 }));
    expect(four.getPoolSize()).toBe(4);
    expect(three.getPoolSize()).toBe(3);
  });

  test('FlowProducer and a TCP Worker accept a fractional poolSize', async () => {
    const connection = { host: HOST, port: closedPort(), poolSize: 2.5 };
    const flow = new FlowProducer({ embedded: false, connection });
    const worker = new Worker('compat-pool', async () => 1, {
      embedded: false,
      autorun: false,
      connection,
    });
    await flow.close();
    await worker.close(true);
  });

  test('maxInFlight, maxCommandTimeouts and maxReconnectAttempts keep their 2.9.10 meaning', () => {
    const resolve = (options: Record<string, number>) =>
      resolveConnectionOptions('TcpClient', options);
    expect(resolve({ maxInFlight: 2.5 }).maxInFlight).toBe(3);
    expect(resolve({ maxCommandTimeouts: 2.5 }).maxCommandTimeouts).toBe(3);
    expect(resolve({ maxCommandTimeouts: -1 }).maxCommandTimeouts).toBe(0);
    expect(resolve({ maxReconnectAttempts: 2.5 }).maxReconnectAttempts).toBe(2);
    expect(resolve({ maxReconnectAttempts: -1 }).maxReconnectAttempts).toBe(0);
    expect(resolve({ maxPingFailures: 2.5 }).maxPingFailures).toBe(3);
  });

  test('TcpConnectionPool accepts maxReconnectAttempts -1 and 2.5', () => {
    for (const maxReconnectAttempts of [-1, 2.5]) {
      const pool = track(
        new TcpConnectionPool({ host: HOST, port: closedPort(), maxReconnectAttempts })
      );
      expect(pool.getPoolSize()).toBe(4);
    }
  });

  test('pingInterval: -1 disables the ping, as 0 does', async () => {
    const broker = startBroker();
    const pool = track(
      new TcpConnectionPool({ host: HOST, port: broker.port, pingInterval: -1, poolSize: 1 })
    );
    expect(internals(pool).options.pingInterval).toBe(0);
    await pool.send({ cmd: 'Count' });
    await Bun.sleep(50);
    expect(broker.count('Ping')).toBe(0);
  });
});

describe('second audit (default entry): more 2.9.10 results', () => {
  const resolve = (options: Record<string, unknown>) =>
    resolveConnectionOptions('TcpClient', options as never);

  test('numeric strings work for every duration and count', () => {
    const resolved = resolve({
      pingInterval: '30000',
      connectTimeout: '5000',
      reconnectDelay: '100',
      maxReconnectDelay: '30000',
      maxReconnectAttempts: '3',
      maxCommandTimeouts: '3',
      maxPingFailures: '3',
    });
    expect(resolved.pingInterval).toBe(30000);
    expect(resolved.connectTimeout).toBe(5000);
    expect(resolved.reconnectDelay).toBe(100);
    expect(resolved.maxReconnectDelay).toBe(30000);
    expect(resolved.maxReconnectAttempts).toBe(3);
    expect(resolved.maxCommandTimeouts).toBe(3);
    expect(resolved.maxPingFailures).toBe(3);
  });

  test('counts beyond exact integers, and NaN where it meant no limit, are no limit', () => {
    expect(resolve({ maxInFlight: 1e20 }).maxInFlight).toBe(Infinity);
    expect(resolve({ maxPingFailures: Number.MAX_VALUE }).maxPingFailures).toBe(Infinity);
    expect(resolve({ maxReconnectAttempts: 1e20 }).maxReconnectAttempts).toBe(Infinity);
    expect(resolve({ maxReconnectAttempts: NaN }).maxReconnectAttempts).toBe(Infinity);
    // `timeouts >= NaN` never fired: the same as 0 (disabled).
    expect(resolve({ maxCommandTimeouts: NaN }).maxCommandTimeouts).toBe(0);
    expect(resolve({ maxPingFailures: 1.5 }).maxPingFailures).toBe(2);
    expect(resolve({ maxInFlight: 0.5 }).maxInFlight).toBe(1);
  });

  test('reconnectDelay accepts Infinity and a base below 1 ms; maxReconnectDelay Infinity', () => {
    expect(resolve({ reconnectDelay: Infinity }).reconnectDelay).toBe(Infinity);
    expect(resolve({ reconnectDelay: 0.5 }).reconnectDelay).toBe(0.5);
    expect(resolve({ maxReconnectDelay: Infinity }).maxReconnectDelay).toBe(Infinity);
    expect(() => resolve({ reconnectDelay: 0 })).toThrow('TcpClient: reconnectDelay');
  });

  test('a falsy non-string token is no token (no Auth), as on 2.9.10', async () => {
    const broker = startBroker();
    for (const token of [false, 0]) {
      const pool = track(
        new TcpConnectionPool({ host: HOST, port: broker.port, poolSize: 1, token: token as never })
      );
      expect((await pool.send({ cmd: 'Ping' })).ok).toBe(true);
    }
    expect(broker.count('Auth')).toBe(0);
    expect(() => resolve({ token: 123 })).toThrow('TcpClient: token must be a string');
  });
});

describe('values 2.9.10 could not use still throw, naming the class and option', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['commandTimeout 0', { commandTimeout: 0 }, 'TcpConnectionPool: commandTimeout'],
    ['reconnectDelay 0', { reconnectDelay: 0 }, 'TcpConnectionPool: reconnectDelay'],
    ['maxReconnectDelay 0', { maxReconnectDelay: 0 }, 'TcpConnectionPool: maxReconnectDelay'],
    ['connectTimeout 0', { connectTimeout: 0 }, 'TcpConnectionPool: connectTimeout'],
    ['host ""', { host: '' }, 'TcpConnectionPool: host'],
    ['poolSize Infinity', { poolSize: Infinity }, 'TcpConnectionPool: poolSize'],
    ['port "abc"', { port: 'abc' }, 'TcpConnectionPool: port'],
    ['port "6789.5"', { port: '6789.5' }, 'TcpConnectionPool: port'],
    ['port "0"', { port: '0' }, 'TcpConnectionPool: port'],
    ['pingInterval NaN', { pingInterval: NaN }, 'TcpConnectionPool: pingInterval'],
    ['pingInterval 0.5', { pingInterval: 0.5 }, 'TcpConnectionPool: pingInterval'],
    ['maxInFlight 0', { maxInFlight: 0 }, 'TcpConnectionPool: maxInFlight'],
  ];
  for (const [label, options, message] of cases) {
    test(label, () => {
      expect(() => new TcpConnectionPool({ host: HOST, ...options })).toThrow(message);
    });
  }

  test('a Queue names the pool and the option', () => {
    expect(
      () => new Queue('compat-bad', { embedded: false, connection: { commandTimeout: 0 } })
    ).toThrow('TcpConnectionPool: commandTimeout must be');
  });
});
