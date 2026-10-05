import { afterEach, expect, test } from 'bun:test';
import { TcpClient } from '../src/client/tcp/client';
import type { ConnectionOptions } from '../src/client/tcp/types';
import { closeAllSharedPools, getSharedPool, TcpConnectionPool } from '../src/client/tcpPool';
import { cleanup, track } from './tcp-client-support';

// Repro: TcpClient validated its durations and limits but not where it connects. A
// NaN, fractional, out-of-range or non-numeric string port, an empty host, or a
// non-string host or token was accepted, and every connection attempt then failed with
// Bun's own message (or a getaddrinfo error), retried by the reconnect loop forever,
// while getSharedPool hashed a numeric token with an unrelated TypeError. A decimal
// string port (`process.env.PORT`) connected on 2.9.10 and still does
// (test/repro-compat-client-connection.test.ts).

afterEach(() => {
  cleanup();
  closeAllSharedPools();
});

type Outcome = { threw: string } | { connect: string };

/** Build a client with `options` and, if that is accepted, report its first connect. */
async function outcomeOf(options: Partial<ConnectionOptions>): Promise<Outcome> {
  let client: TcpClient;
  try {
    client = track(new TcpClient({ autoReconnect: false, pingInterval: 0, ...options }));
  } catch (error) {
    return { threw: `${(error as Error).name}: ${(error as Error).message}` };
  }
  client.on('error', () => undefined);
  return {
    connect: await client.connect().then(
      () => 'connected',
      (error: Error) => error.message
    ),
  };
}

test.each<[string, Partial<ConnectionOptions>, string]>([
  [
    'port NaN',
    { port: Number.NaN },
    'RangeError: TcpClient: port must be a whole number between 1 and 65535 (got NaN)',
  ],
  [
    'port 0',
    { port: 0 },
    'RangeError: TcpClient: port must be a whole number between 1 and 65535 (got 0)',
  ],
  [
    'port 70000',
    { port: 70_000 },
    'RangeError: TcpClient: port must be a whole number between 1 and 65535 (got 70000)',
  ],
  [
    'port 6789.5',
    { port: 6789.5 },
    'RangeError: TcpClient: port must be a whole number between 1 and 65535 (got 6789.5)',
  ],
  [
    'port "http"',
    { port: 'http' as unknown as number },
    'TypeError: TcpClient: port must be a whole number between 1 and 65535 (got "http")',
  ],
  [
    'port "6789.5"',
    { port: '6789.5' as unknown as number },
    'TypeError: TcpClient: port must be a whole number between 1 and 65535 (got "6789.5")',
  ],
  [
    'host ""',
    { host: '' },
    'RangeError: TcpClient: host must be a non-empty hostname or IP address (got "")',
  ],
  [
    'host "  "',
    { host: '  ' },
    'RangeError: TcpClient: host must be a non-empty hostname or IP address (got "  ")',
  ],
  [
    'host 127',
    { host: 127 as unknown as string },
    'TypeError: TcpClient: host must be a non-empty hostname or IP address (got 127)',
  ],
  [
    'token 123',
    { token: 123 as unknown as string },
    'TypeError: TcpClient: token must be a string (got 123)',
  ],
])('%s is rejected at construction', async (_, options, message) => {
  expect(await outcomeOf({ host: '127.0.0.1', port: 1, ...options })).toEqual({ threw: message });
});

test('pools reject an invalid port or token before keying or building', () => {
  expect(() => getSharedPool({ port: Number.NaN })).toThrow(
    'TcpConnectionPool: port must be a whole number between 1 and 65535 (got NaN)'
  );
  expect(() => getSharedPool({ token: 123 as unknown as string })).toThrow(
    'TcpConnectionPool: token must be a string (got 123)'
  );
  expect(() => track(new TcpConnectionPool({ host: '' }))).toThrow(
    'TcpConnectionPool: host must be a non-empty hostname or IP address (got "")'
  );
});

test('valid targets and unset values are accepted', () => {
  for (const options of [
    { host: 'localhost', port: 1 },
    { host: '::1', port: 65_535 },
    { host: undefined, port: undefined, token: undefined },
    { host: null, port: null, token: null } as unknown as Partial<ConnectionOptions>,
    { token: '' },
  ]) {
    expect(() => track(new TcpClient(options))).not.toThrow();
  }
});
