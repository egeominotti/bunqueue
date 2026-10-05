import { afterEach, expect, test } from 'bun:test';
import { getPoolKey } from '../src/client/tcp/poolKey';
import { closeSharedTcpClient, getSharedTcpClient } from '../src/client/tcp/shared';
import { closeAllSharedPools, getSharedPool, TcpConnectionPool } from '../src/client/tcpPool';
import { cleanup, track } from './tcp-client-support';

// Repro: pools (TcpConnectionPool, getSharedPool) and shared clients took their
// durations and limits unvalidated. A NaN pingInterval or commandTimeout built
// connections that flood Ping or time every command out; a shared pool or client keyed
// by other options was handed to a caller whose options were invalid; a NaN poolSize
// built a pool without connections (its send throws a TypeError) and an infinite one
// made the constructor loop until the process ran out of memory.

const HOST = { host: '127.0.0.1', port: 1 };

afterEach(() => {
  cleanup();
  closeAllSharedPools();
  closeSharedTcpClient();
});

test('new TcpConnectionPool rejects a NaN pingInterval', () => {
  expect(() => track(new TcpConnectionPool({ ...HOST, pingInterval: Number.NaN }))).toThrow(
    /pingInterval must be/
  );
});

test('getSharedPool rejects a NaN commandTimeout and registers no pool', () => {
  expect(() => getSharedPool({ ...HOST, commandTimeout: Number.NaN })).toThrow(
    'TcpConnectionPool: commandTimeout must be'
  );
  const pool = getSharedPool({ ...HOST });
  expect(pool.isClosed()).toBe(false);
  // Equal options share (the explicit default); other timeouts get their own pool.
  expect(getSharedPool({ ...HOST, commandTimeout: 30_000 })).toBe(pool);
});

test('getSharedPool does not hand an existing pool to options it rejects', () => {
  const pool = getSharedPool({ ...HOST });
  expect(() => getSharedPool({ ...HOST, pingInterval: Number.NaN })).toThrow(RangeError);
  expect(() => getSharedPool({ ...HOST, reconnectDelay: -5 })).toThrow(RangeError);
  expect(getSharedPool({ ...HOST })).toBe(pool);
});

test('getSharedPool rejects a NaN poolSize instead of building a pool without connections', () => {
  let pool: TcpConnectionPool | undefined;
  expect(() => {
    pool = getSharedPool({ ...HOST, poolSize: Number.NaN });
  }).toThrow('TcpConnectionPool: poolSize must be');
  expect(pool?.getPoolSize()).toBeUndefined();
});

test('an infinite poolSize is rejected before a shared pool is built', () => {
  // getSharedPool computes the key first, so a key that throws never reaches the
  // constructor's loop (asserted first: on failure the loop would never return).
  expect(() => getPoolKey({ ...HOST, poolSize: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  expect(() => getSharedPool({ ...HOST, poolSize: Number.POSITIVE_INFINITY })).toThrow(
    'TcpConnectionPool: poolSize must be'
  );
});

test('getSharedTcpClient validates before it shares a client', () => {
  expect(() => getSharedTcpClient({ ...HOST, maxInFlight: 0 })).toThrow(RangeError);
  const client = getSharedTcpClient({ ...HOST });
  expect(() => getSharedTcpClient({ ...HOST, commandTimeout: Number.NaN })).toThrow(RangeError);
  expect(getSharedTcpClient({ ...HOST })).toBe(client);
});

// A direct pool (Queue with another poolSize, Worker, MCP) validated only through its
// first TcpClient: errors named `TcpClient:` and poolSize was never checked.

test('new TcpConnectionPool names itself in a rejected duration', () => {
  expect(() => track(new TcpConnectionPool({ ...HOST, pingInterval: Number.NaN }))).toThrow(
    /^TcpConnectionPool: pingInterval must be/
  );
});

test('new TcpConnectionPool rejects a NaN poolSize instead of building no connection', () => {
  let pool: TcpConnectionPool | undefined;
  expect(() => {
    pool = track(new TcpConnectionPool({ ...HOST, poolSize: Number.NaN }));
  }).toThrow('TcpConnectionPool: poolSize must be a whole number <= 65535 (got NaN)');
  expect(pool?.getPoolSize()).toBeUndefined();
});

test('new TcpConnectionPool rejects an infinite poolSize instead of looping', async () => {
  // A fresh process: on failure the constructor loops until it runs out of memory.
  const script = `
    import { TcpConnectionPool } from ${JSON.stringify(`${import.meta.dir}/../src/client/tcpPool`)};
    try { new TcpConnectionPool({ poolSize: Infinity }); console.log('built'); }
    catch (error) { console.log(error.name + ': ' + error.message); }
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => 'hung')]);
  if (exited === 'hung') child.kill(9);
  const output = (await new Response(child.stdout).text()).trim();
  expect({ exited, output }).toEqual({
    exited: 0,
    output:
      'RangeError: TcpConnectionPool: poolSize must be a whole number <= 65535 (got Infinity)',
  });
});
