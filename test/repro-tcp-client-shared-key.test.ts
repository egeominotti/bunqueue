import { afterEach, expect, test } from 'bun:test';
import { getPoolKey } from '../src/client/tcp/poolKey';
import { closeSharedTcpClient, getSharedTcpClient } from '../src/client/tcp/shared';
import type { ConnectionOptions } from '../src/client/tcp/types';
import { closeAllSharedPools, getSharedPool, type PoolOptions } from '../src/client/tcpPool';

// Repro: shared pools and shared clients were keyed by host, port, a token
// fingerprint, TLS and (pools only) poolSize, pipelining and maxInFlight. A later
// caller with other timeouts, ping or reconnect settings silently received the first
// caller's connections. The token fingerprint, `Number(Bun.hash(token)) & 0xffff`,
// rounds the 64-bit hash to a double before masking, so it takes about 1,900 values:
// 'token-10' and 'token-12' already collide, and a pool built for one token was handed
// to a caller with the other, which then ran its commands under the wrong identity.

afterEach(() => {
  closeAllSharedPools();
  closeSharedTcpClient();
});

const HOST = { host: '127.0.0.1', port: 1 };

/** The options a pooled connection runs with (white-box, as test/repro-option-drop-class). */
function clientOptions(pool: ReturnType<typeof getSharedPool>): Required<ConnectionOptions> {
  const clients = (pool as unknown as { clients: Array<{ options: Required<ConnectionOptions> }> })
    .clients;
  return clients[0].options;
}

test.each<[string, PoolOptions]>([
  ['commandTimeout', { commandTimeout: 2_000 }],
  ['connectTimeout', { connectTimeout: 2_000 }],
  ['pingInterval', { pingInterval: 0 }],
  ['maxPingFailures', { maxPingFailures: 5 }],
  ['maxCommandTimeouts', { maxCommandTimeouts: 0 }],
  ['reconnectDelay', { reconnectDelay: 500 }],
  ['maxReconnectDelay', { maxReconnectDelay: 5_000 }],
  ['maxReconnectAttempts', { maxReconnectAttempts: 3 }],
  ['autoReconnect', { autoReconnect: false }],
])('a shared pool with another %s is a different pool', (key, options) => {
  const first = getSharedPool({ ...HOST });
  const second = getSharedPool({ ...HOST, ...options });
  const name = key as keyof ConnectionOptions;
  expect({ same: second === first, value: clientOptions(second)[name] }).toEqual({
    same: false,
    value: options[name],
  });
});

test('tokens whose old 16-bit fingerprints collide get different pools and clients', () => {
  expect(Number(Bun.hash('token-10')) & 0xffff).toBe(Number(Bun.hash('token-12')) & 0xffff);
  const pool = getSharedPool({ ...HOST, token: 'token-10' });
  const other = getSharedPool({ ...HOST, token: 'token-12' });
  const client = getSharedTcpClient({ ...HOST, token: 'token-10' });
  const otherClient = getSharedTcpClient({ ...HOST, token: 'token-12' });
  expect({
    samePool: other === pool,
    sameClient: otherClient === client,
    token: clientOptions(other).token,
  }).toEqual({ samePool: false, sameClient: false, token: 'token-12' });
});

test('a shared client with other timeouts is a different client', () => {
  const client = getSharedTcpClient({ ...HOST });
  expect(getSharedTcpClient({ ...HOST, commandTimeout: 2_000 }) === client).toBe(false);
});

test('spellings of the same options still share one pool', () => {
  const pool = getSharedPool({ ...HOST });
  const explicitDefaults: PoolOptions = {
    ...HOST,
    poolSize: 4,
    commandTimeout: 30_000,
    connectTimeout: 5_000,
    pingInterval: 30_000,
    maxInFlight: 100,
    pipelining: true,
    token: '',
    tls: false,
  };
  expect(getSharedPool(explicitDefaults)).toBe(pool);
  expect(getSharedPool({ ...HOST, commandTimeout: undefined, pingInterval: undefined })).toBe(pool);
  const tls = getSharedPool({ ...HOST, tls: { caFile: '/ca.pem', rejectUnauthorized: true } });
  expect(getSharedPool({ ...HOST, tls: { rejectUnauthorized: true, caFile: '/ca.pem' } })).toBe(
    tls
  );
  expect(getPoolKey({ poolSize: 0 })).toBe(getPoolKey({ poolSize: 1 }));
});
