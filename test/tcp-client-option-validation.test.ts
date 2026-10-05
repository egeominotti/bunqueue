import { afterEach, describe, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import { getPoolKey } from '../src/client/tcp/poolKey';
import { DEFAULT_CONNECTION, type ConnectionOptions } from '../src/client/tcp/types';
import {
  closeAllSharedPools,
  getSharedPool,
  TcpConnectionPool,
  type PoolOptions,
} from '../src/client/tcpPool';
import { cleanup, THIRTY_DAYS, track } from './tcp-client-support';

// Every numeric ConnectionOptions/PoolOptions value is checked where a client or a
// pool is built: rejected values throw a TypeError (not a number) or a RangeError
// naming the owner and the option; `undefined` means the default. Values 2.9.10 read
// with a well-defined result are first normalized to it (NORMALIZED below; see
// test/repro-compat-client-connection.test.ts).

afterEach(() => {
  cleanup();
  closeAllSharedPools();
});

type Key = keyof ConnectionOptions;
const INF = Number.POSITIVE_INFINITY;

const REJECTED: Array<[Key, unknown, string]> = [
  ['connectTimeout', Number.NaN, 'RangeError'],
  ['connectTimeout', 0, 'RangeError'],
  ['connectTimeout', 0.5, 'RangeError'],
  ['connectTimeout', -1, 'RangeError'],
  ['connectTimeout', INF, 'RangeError'],
  ['connectTimeout', 'soon', 'TypeError'],
  ['commandTimeout', Number.NaN, 'RangeError'],
  ['commandTimeout', 0, 'RangeError'],
  ['commandTimeout', -1, 'RangeError'],
  ['commandTimeout', -INF, 'RangeError'],
  ['commandTimeout', true, 'TypeError'],
  ['pingInterval', Number.NaN, 'RangeError'],
  ['pingInterval', 0.5, 'RangeError'],
  ['pingInterval', 'often', 'TypeError'],
  ['reconnectDelay', Number.NaN, 'RangeError'],
  ['reconnectDelay', 0, 'RangeError'],
  ['reconnectDelay', -1, 'RangeError'],
  ['maxReconnectDelay', Number.NaN, 'RangeError'],
  ['maxReconnectDelay', 0, 'RangeError'],
  ['maxReconnectAttempts', 'three', 'TypeError'],
  ['maxPingFailures', Number.NaN, 'RangeError'],
  ['maxPingFailures', 0, 'RangeError'],
  ['maxPingFailures', -1, 'RangeError'],
  ['maxCommandTimeouts', 'three', 'TypeError'],
  ['maxInFlight', Number.NaN, 'RangeError'],
  ['maxInFlight', 0, 'RangeError'],
  ['maxInFlight', -INF, 'RangeError'],
];

const ACCEPTED: Array<[Key, number]> = [
  ['connectTimeout', 1],
  ['connectTimeout', THIRTY_DAYS],
  ['commandTimeout', 1],
  ['commandTimeout', THIRTY_DAYS],
  ['commandTimeout', INF],
  ['pingInterval', 0],
  ['pingInterval', 1],
  ['pingInterval', THIRTY_DAYS],
  ['pingInterval', INF],
  ['reconnectDelay', 1],
  ['reconnectDelay', 0.5],
  ['reconnectDelay', THIRTY_DAYS],
  ['reconnectDelay', INF],
  ['maxReconnectDelay', 1],
  ['maxReconnectDelay', Number.MAX_VALUE],
  ['maxReconnectDelay', INF],
  ['maxReconnectAttempts', 0],
  ['maxReconnectAttempts', INF],
  ['maxPingFailures', 1],
  ['maxPingFailures', INF],
  ['maxCommandTimeouts', 0],
  ['maxCommandTimeouts', INF],
  ['maxInFlight', 1],
  ['maxInFlight', INF],
];

/** Values 2.9.10 read with a well-defined result, normalized to it. */
const NORMALIZED: Array<[Key, unknown, number]> = [
  ['connectTimeout', '5000', 5000],
  ['pingInterval', -1, 0],
  ['pingInterval', -INF, 0],
  ['pingInterval', '30000', 30000],
  ['maxReconnectAttempts', Number.NaN, INF],
  ['maxReconnectAttempts', -1, 0],
  ['maxReconnectAttempts', 1.5, 1],
  ['maxReconnectAttempts', '3', 3],
  ['maxPingFailures', 2.5, 3],
  ['maxCommandTimeouts', Number.NaN, 0],
  ['maxCommandTimeouts', -1, 0],
  ['maxCommandTimeouts', 1.5, 2],
  ['maxInFlight', 1.5, 2],
  ['maxInFlight', 1e20, INF],
];

/** The options a built client resolved (white-box, as test/repro-option-drop-class does). */
function resolved(client: TcpClient): Required<ConnectionOptions> {
  return (client as unknown as { options: Required<ConnectionOptions> }).options;
}

describe('TcpClient', () => {
  test.each(REJECTED)('%s = %p throws a %s', (key, value, kind) => {
    const build = () => track(new TcpClient({ [key]: value } as Partial<ConnectionOptions>));
    expect(build).toThrow(new RegExp(`^TcpClient: ${key} must be .* \\(got .+\\)$`));
    try {
      build();
    } catch (error) {
      expect((error as Error).name).toBe(kind);
    }
  });

  test.each(ACCEPTED)('%s = %p is used as given', (key, value) => {
    const client = track(new TcpClient({ [key]: value } as Partial<ConnectionOptions>));
    expect(resolved(client)[key]).toBe(value);
  });

  test.each(NORMALIZED)('%s = %p is read as %p, as on 2.9.10', (key, value, expected) => {
    const client = track(new TcpClient({ [key]: value } as Partial<ConnectionOptions>));
    expect(resolved(client)[key]).toBe(expected);
  });

  test.each(
    (Object.keys(DEFAULT_CONNECTION) as Key[]).flatMap((key) => [
      [key, undefined],
      [key, null],
    ])
  )('%s = %p means the default', (key, value) => {
    const client = track(new TcpClient({ [key]: value } as Partial<ConnectionOptions>));
    expect(resolved(client)[key]).toEqual(DEFAULT_CONNECTION[key as Key]);
  });

  test('messages name the accepted range', () => {
    expect(() => new TcpClient({ pingInterval: Number.NaN })).toThrow(
      'TcpClient: pingInterval must be a finite number of milliseconds >= 0 or Infinity (got NaN)'
    );
    expect(() => new TcpClient({ pingInterval: 0.5 })).toThrow(
      'TcpClient: pingInterval must be 0 (disabled) or at least 1 ms (got 0.5)'
    );
    expect(() => new TcpClient({ reconnectDelay: 0 })).toThrow(
      'TcpClient: reconnectDelay must be a number of milliseconds above 0, or Infinity (got 0)'
    );
    expect(() => new TcpClient({ maxInFlight: 0 })).toThrow(
      'TcpClient: maxInFlight must be a whole number >= 1 or Infinity (got 0)'
    );
    expect(() => new TcpClient({ maxCommandTimeouts: 'three' as unknown as number })).toThrow(
      'TcpClient: maxCommandTimeouts must be a whole number >= 0 or Infinity (got "three")'
    );
  });
});

describe('pools', () => {
  test.each(REJECTED)('getSharedPool: %s = %p throws a %s', (key, value, kind) => {
    const options = { host: '127.0.0.1', port: 1, [key]: value } as PoolOptions;
    expect(() => getSharedPool(options)).toThrow(`TcpConnectionPool: ${key} must be`);
    expect(() => track(new TcpConnectionPool(options))).toThrow(
      `TcpConnectionPool: ${key} must be`
    );
    try {
      getSharedPool(options);
    } catch (error) {
      expect((error as Error).name).toBe(kind);
    }
  });

  test.each([Number.NaN, INF, 'four', 65_536, 1e9])('poolSize %p is rejected', (poolSize) => {
    const options = { host: '127.0.0.1', port: 1, poolSize: poolSize as number };
    const message = /^TcpConnectionPool: poolSize must be a whole number <= 65535 \(got .+\)$/;
    expect(() => getPoolKey(options)).toThrow(message);
    expect(() => track(new TcpConnectionPool(options))).toThrow(message);
  });

  test.each([1, 4, 64, 0, -3])('poolSize %p is accepted (below 1 means one connection)', (size) => {
    const pool = getSharedPool({ host: '127.0.0.1', port: 1, poolSize: size });
    expect(pool.getPoolSize()).toBe(Math.max(1, size));
    expect(track(new TcpConnectionPool({ poolSize: size })).getPoolSize()).toBe(Math.max(1, size));
  });

  test.each([
    [1.5, 2],
    ['4', 4],
    [-INF, 1],
  ] as const)('poolSize %p builds %p connections, as on 2.9.10', (poolSize, size) => {
    const options = { host: '127.0.0.1', port: 1, poolSize: poolSize as number };
    expect(track(new TcpConnectionPool(options)).getPoolSize()).toBe(size);
    expect(getPoolKey(options)).toStartWith(`${size}:`);
  });

  test('the ceiling, 65535 connections, is accepted', () => {
    expect(getPoolKey({ poolSize: 65_535 })).toStartWith('65535:');
  });

  test('the shared-pool key normalizes undefined to the defaults', () => {
    const explicit = { pipelining: undefined, maxInFlight: undefined, poolSize: undefined };
    expect(getPoolKey(explicit)).toBe(getPoolKey({}));
    expect(getPoolKey({ maxInFlight: 100, poolSize: 4 })).toBe(getPoolKey());
  });
});
