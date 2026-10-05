/**
 * Repro: `bunqueue healthcheck` (the Docker HEALTHCHECK) put HTTP_PORT into its URL
 * raw. The server trims and validates the variable, so `HTTP_PORT=" 6790"` started a
 * healthy server while every probe built `http://127.0.0.1: 6790/health`, an invalid
 * URL, and reported the container unhealthy. `HTTP_PORT=6790abc` likewise.
 *
 * The probe now resolves the port with the server's own setting (name, default, digits
 * only). It must reach a real port, so 0 (OS-assigned) is refused with a clear message;
 * an explicit URL argument still bypasses the variable.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { REPO, runChild } from './config-test-support';

async function probe(env: Record<string, string>, args: string[] = []) {
  const run = await runChild([join(REPO, 'src/main.ts'), 'healthcheck', ...args], {
    cwd: REPO,
    env,
    killAfterMs: 10_000,
  });
  return { code: run.exitCode, output: run.output };
}

function healthyServer() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ status: 'healthy' }),
  });
}

test('HTTP_PORT with surrounding spaces reaches the server, as the server reads it', async () => {
  const server = healthyServer();
  try {
    expect(await probe({ HTTP_PORT: ` ${server.port} ` })).toEqual({
      code: 0,
      output: 'healthy\n',
    });
  } finally {
    server.stop(true);
  }
});

test.each([
  ['abc', 'Invalid HTTP_PORT: "abc" (expected a whole number between 1 and 65535)'],
  ['6790abc', 'Invalid HTTP_PORT: "6790abc" (expected a whole number between 1 and 65535)'],
  ['0', 'Invalid HTTP_PORT: "0" (expected a whole number between 1 and 65535)'],
])('HTTP_PORT=%p fails closed with the reason', async (raw, reason) => {
  expect(await probe({ HTTP_PORT: raw })).toEqual({
    code: 1,
    output: `Health check failed: ${reason}\n`,
  });
});

test('an explicit URL still wins over HTTP_PORT', async () => {
  const server = healthyServer();
  try {
    expect(await probe({ HTTP_PORT: 'abc' }, [`http://127.0.0.1:${server.port}/health`])).toEqual({
      code: 0,
      output: 'healthy\n',
    });
  } finally {
    server.stop(true);
  }
});
