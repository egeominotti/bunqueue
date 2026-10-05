/**
 * End to end: a malformed server-runtime env var stops `bunqueue` (src/main.ts) at
 * startup with exit code 1 and a message naming the variable and the value, not a stack
 * trace, and it never leaves a running server behind. Before, every one of these values
 * booted a server with a spinning interval, a 1 ms lock or stall timer, or a leak.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnChild } from './server-runtime-support';

setDefaultTimeout(60_000);

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** `Invalid NAME: "raw"`, also when a structured log line escaped the quotes. */
function invalidMessage(name: string, raw: string): RegExp {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Invalid ${name}: \\\\?"${escaped}\\\\?"`);
}

const STACK_FRAME = /\n\s+at .+:\d+:\d+/;

describe('server startup with a malformed runtime env var', () => {
  test('exits 1 with the variable named and no stack trace', async () => {
    const cases: Array<[string, string]> = [
      ['LOCK_TIMEOUT_MS', 'abc'],
      ['WORKER_CLEANUP_INTERVAL_MS', '-1'],
      ['WORKER_TIMEOUT_MS', '1e12'],
      ['TCP_IDLE_TIMEOUT_MS', '1e12'],
      ['TCP_MAX_WRITE_QUEUE_BYTES', '64MB'],
      // `0` started 2.9.10 (no sweep): it keeps the default sweep with a warning now.
      ['RATE_LIMIT_CLEANUP_MS', '1e12'],
    ];
    const results = await Promise.all(
      cases.map(async ([name, raw]) => {
        const [tcp, http] = [await freePort(), await freePort()];
        return spawnChild(
          [process.execPath, 'src/main.ts'],
          { [name]: raw, HOST: '127.0.0.1', TCP_PORT: String(tcp), HTTP_PORT: String(http) },
          10_000
        );
      })
    );
    for (const [index, [name, raw]] of cases.entries()) {
      const result = results[index];
      expect({ name, exitCode: result.exitCode }).toEqual({ name, exitCode: 1 });
      expect(result.output).toMatch(invalidMessage(name, raw));
      expect(result.output).not.toMatch(STACK_FRAME);
    }
  });
});
