/**
 * Repro: the TCP slowloris stall timer and write-queue cap.
 *
 * - TCP_IDLE_TIMEOUT_MS used `max(0, parseInt || 0)`: `1e12` (parseInt: 1) or a value
 *   above 2^31 - 1 terminated any connection holding a partial frame after about 1 ms,
 *   and `abc`/`-1` silently disabled the guard. The programmatic `idleTimeoutMs` had the
 *   same overflow and a NaN reached setTimeout.
 * - TCP_MAX_WRITE_QUEUE_BYTES used the same parse: `64MB` became a 64-byte cap and `abc`
 *   silently removed the cap.
 *
 * Misreads now fail server creation. `abc` and `-1` (2.9.10: the guard is off) keep
 * starting, with the guard off as before and a warning (upgrade compatibility).
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { resolveMaxWriteQueueBytes } from '../src/infrastructure/server/tcp/constants';
import { REPO, TIMER_WARNING, runChild } from './server-runtime-support';

setDefaultTimeout(60_000);

let manager: QueueManager | null = null;
let server: TcpServer | null = null;

afterEach(() => {
  server?.stop();
  manager?.shutdown();
  server = null;
  manager = null;
});

/** Open a connection, announce a 100-byte frame, send 3 bytes, report if it closes. */
async function partialFrameSurvives(idleTimeoutMs: number, waitMs: number): Promise<boolean> {
  manager = new QueueManager();
  server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0, idleTimeoutMs });
  let closed = false;
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: server.server.port,
    socket: {
      data() {},
      close() {
        closed = true;
      },
      error() {},
    },
  });
  socket.write(new Uint8Array([0, 0, 0, 100, 1, 2, 3]));
  await Bun.sleep(waitMs);
  const survived = !closed; // read first: end() can run the close handler synchronously
  socket.end();
  return survived;
}

function creationError(config: { idleTimeoutMs?: number; maxWriteQueueBytes?: number }): unknown {
  manager = new QueueManager();
  try {
    server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0, ...config });
    return null;
  } catch (error) {
    return error;
  }
}

describe('TcpServerConfig.idleTimeoutMs', () => {
  test('a stall timeout above the native timer limit keeps a partial frame open', async () => {
    expect(await partialFrameSurvives(2 ** 31, 200)).toBe(true);
  });

  test('a short stall timeout still terminates a stalled partial frame', async () => {
    expect(await partialFrameSurvives(30, 400)).toBe(false);
  });

  test('NaN, negative and non-number timeouts are rejected when the server is created', () => {
    for (const idleTimeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const error = creationError({ idleTimeoutMs });
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain('TcpServerConfig.idleTimeoutMs');
      server?.stop();
      manager?.shutdown();
      server = null;
      manager = null;
    }
    const error = creationError({ idleTimeoutMs: '100' as unknown as number });
    expect(error).toBeInstanceOf(TypeError);
  });

  test('NaN and fractional write-queue caps are rejected when the server is created', () => {
    for (const maxWriteQueueBytes of [Number.NaN, -1, 1.5]) {
      const error = creationError({ maxWriteQueueBytes });
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain('TcpServerConfig.maxWriteQueueBytes');
      server?.stop();
      manager?.shutdown();
      server = null;
      manager = null;
    }
  });
});

/** Create the TCP server from env defaults; report the error message if it fails. */
const SERVER_PROBE = `
  const { QueueManager } = await import('${REPO}/src/application/queueManager.ts');
  const { createTcpServer } = await import('${REPO}/src/infrastructure/server/tcp.ts');
  const manager = new QueueManager();
  try {
    createTcpServer(manager, { hostname: '127.0.0.1', port: 0 }).stop();
  } finally {
    manager.shutdown();
  }
  report({ created: true });
`;

describe('TcpServerConfig.maxWriteQueueBytes messages', () => {
  // The shared assertInteger rule (src/shared/durations.ts), with the unit kept.
  const message = (shown: string) =>
    `TcpServerConfig.maxWriteQueueBytes must be a whole number of bytes >= 0 (got ${shown})`;

  test.each([
    [-1, RangeError, '-1'],
    [1.5, RangeError, '1.5'],
    [2 ** 53, RangeError, '9007199254740992, not a safe integer'],
    ['64k', TypeError, '"64k"'],
  ] as const)('%p throws %p with the exact message', (value, ErrorType, shown) => {
    expect(() => resolveMaxWriteQueueBytes(value as number)).toThrow(ErrorType);
    expect(() => resolveMaxWriteQueueBytes(value as number)).toThrow(message(shown));
  });

  test('0 (disabled) and a positive cap are accepted', () => {
    expect(resolveMaxWriteQueueBytes(0)).toBe(0);
    expect(resolveMaxWriteQueueBytes(1_048_576)).toBe(1_048_576);
  });
});

describe('TCP_IDLE_TIMEOUT_MS and TCP_MAX_WRITE_QUEUE_BYTES', () => {
  test('values parseInt misread fail server creation', async () => {
    const cases: Array<[string, string, string]> = [
      ['TCP_IDLE_TIMEOUT_MS', '1e12', 'a whole number of milliseconds >= 0'],
      ['TCP_IDLE_TIMEOUT_MS', '60s', 'a whole number of milliseconds >= 0'],
      ['TCP_MAX_WRITE_QUEUE_BYTES', '64MB', 'a whole number of bytes >= 0'],
      ['TCP_MAX_WRITE_QUEUE_BYTES', '1e9', 'a whole number of bytes >= 0'],
    ];
    const results = await Promise.all(
      cases.map(([name, raw]) => runChild(SERVER_PROBE, { [name]: raw }))
    );
    for (const [index, [name, raw, expected]] of cases.entries()) {
      expect(results[index].report).toEqual({
        ok: false,
        name: 'Error',
        error: `Invalid ${name}: ${JSON.stringify(raw)} (expected ${expected})`,
      });
    }
  });

  test('values 2.9.10 read as "disabled" (abc, -1) still start, with a warning', async () => {
    const cases: Array<[string, string]> = [
      ['TCP_IDLE_TIMEOUT_MS', 'abc'],
      ['TCP_IDLE_TIMEOUT_MS', '-1'],
      ['TCP_MAX_WRITE_QUEUE_BYTES', 'abc'],
      ['TCP_MAX_WRITE_QUEUE_BYTES', '-1'],
    ];
    const results = await Promise.all(
      cases.map(([name, raw]) => runChild(SERVER_PROBE, { [name]: raw }))
    );
    for (const [index, [name, raw]] of cases.entries()) {
      expect(results[index].report).toEqual({ ok: true, created: true });
      expect(results[index].output).toContain(`Invalid ${name}: ${JSON.stringify(raw)}`);
    }
  });

  test('documented values are accepted: 0 disables, long values are honoured', async () => {
    const results = await Promise.all([
      runChild(SERVER_PROBE, { TCP_IDLE_TIMEOUT_MS: '0', TCP_MAX_WRITE_QUEUE_BYTES: '0' }),
      runChild(SERVER_PROBE, {
        TCP_IDLE_TIMEOUT_MS: '99999999999',
        TCP_MAX_WRITE_QUEUE_BYTES: '134217728',
      }),
    ]);
    for (const result of results) {
      expect(result.report).toEqual({ ok: true, created: true });
      expect(result.output).not.toMatch(TIMER_WARNING);
    }
  });
});
