import { afterEach, expect, test } from 'bun:test';
import { createBackend } from '../src/mcp/adapter';
import { handlerConnectionFromEnv } from '../src/mcp/httpHandler';
import { cleanup, startBroker } from './tcp-client-support';

// Repro: the MCP server read BUNQUEUE_PORT with parseInt in createBackend and in the
// HTTP-handler connection, so "6789abc" connected to port 6789, "1e4" to port 1, and
// "abc" or "70000" reached the TCP pool as NaN or an out-of-range port: the backend
// connected to a broker the operator did not name, or every attempt failed with an
// error that did not mention the variable. BUNQUEUE_PORT is now a decimal integer
// from 1 to 65535, parsed once (parseIntegerEnv), and anything else stops startup.

const KEYS = ['BUNQUEUE_MODE', 'BUNQUEUE_HOST', 'BUNQUEUE_PORT', 'BUNQUEUE_POOL_SIZE'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  cleanup();
});

const expected = (raw: string) =>
  `Invalid BUNQUEUE_PORT: ${JSON.stringify(raw)} (expected a whole number between 1 and 65535)`;

/** createBackend() with BUNQUEUE_PORT = `raw` against a live broker on 127.0.0.1. */
async function createBackendWith(raw: (port: number) => string): Promise<string> {
  const broker = startBroker();
  process.env.BUNQUEUE_MODE = 'tcp';
  process.env.BUNQUEUE_HOST = '127.0.0.1';
  process.env.BUNQUEUE_PORT = raw(broker.port);
  try {
    const backend = await createBackend();
    await (backend as unknown as { shutdown(): Promise<void> | void }).shutdown();
    return 'connected';
  } catch (error) {
    return (error as Error).message;
  }
}

test('createBackend refuses a port with trailing garbage instead of connecting', async () => {
  const outcome = await createBackendWith((port) => `${port}abc`);
  expect(outcome).toMatch(
    /^Invalid BUNQUEUE_PORT: "\d+abc" \(expected a whole number between 1 and 65535\)$/
  );
});

test('createBackend still connects with a valid port', async () => {
  expect(await createBackendWith((port) => ` ${port} `)).toBe('connected');
});

// `6789.5` is read as 6789, as 2.9.10's parseInt did (see the next test).
test.each(['6789abc', '1e4', 'abc', '0', '70000', '-1', '0x1a85', '   '])(
  'the handler connection refuses BUNQUEUE_PORT=%p',
  (raw) => {
    const env = { BUNQUEUE_MODE: 'tcp', BUNQUEUE_PORT: raw };
    let outcome: unknown;
    try {
      outcome = handlerConnectionFromEnv(env);
    } catch (error) {
      outcome = (error as Error).message;
    }
    expect(outcome).toBe(expected(raw));
  }
);

test('the handler connection reads a valid or unset BUNQUEUE_PORT and a blank host as unset', () => {
  expect(handlerConnectionFromEnv({ BUNQUEUE_MODE: 'tcp', BUNQUEUE_PORT: '7000' })?.port).toBe(
    7000
  );
  expect(handlerConnectionFromEnv({ BUNQUEUE_MODE: 'tcp', BUNQUEUE_PORT: '6789.5' })?.port).toBe(
    6789
  );
  expect(handlerConnectionFromEnv({ BUNQUEUE_MODE: 'tcp' })).toEqual({
    host: undefined,
    port: undefined,
    token: undefined,
  });
  expect(
    handlerConnectionFromEnv({ BUNQUEUE_MODE: 'tcp', BUNQUEUE_PORT: '', BUNQUEUE_HOST: '  ' })
  ).toEqual({ host: undefined, port: undefined, token: undefined });
  expect(handlerConnectionFromEnv({ BUNQUEUE_PORT: 'abc' })).toBeUndefined(); // embedded
});
