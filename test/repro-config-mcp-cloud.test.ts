/**
 * Repro (process level): `bunqueue-mcp` resolved the Cloud configuration only after its
 * HTTP transport was listening. An invalid Cloud value then stopped a server that had
 * already bound its port (and, before that, a bind failure hid the Cloud error).
 *
 * The Cloud configuration must be validated before any transport starts. The proof
 * is deterministic: the MCP HTTP port is already taken, so whichever check runs
 * first decides the error. The error must name the Cloud variable, not the bind.
 */

import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeSandbox, REPO, runChild } from './config-test-support';

const box = makeSandbox('bunqueue-mcp-cloud-');
afterAll(() => box.cleanup());

test('an invalid Cloud setting stops bunqueue-mcp before its HTTP transport binds', async () => {
  const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  try {
    const run = await runChild([join(REPO, 'src/mcp/index.ts')], {
      cwd: box.dir,
      killAfterMs: 10_000,
      env: {
        BUNQUEUE_MODE: 'embedded',
        BUNQUEUE_DATA_PATH: box.dataPath,
        BUNQUEUE_MCP_TRANSPORT: 'http',
        BUNQUEUE_MCP_HTTP_HOST: '127.0.0.1',
        BUNQUEUE_MCP_HTTP_PORT: String(blocker.port),
        BUNQUEUE_CLOUD_URL: 'https://cloud.example',
        BUNQUEUE_CLOUD_API_KEY: 'key',
        BUNQUEUE_CLOUD_INSTANCE_ID: 'instance-1',
        BUNQUEUE_CLOUD_BUFFER_SIZE: 'abc',
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(
      'Invalid BUNQUEUE_CLOUD_BUFFER_SIZE: "abc" (expected a whole number >= 1)'
    );
    expect(run.output).not.toMatch(/EADDRINUSE|Failed to start|in use/i);
  } finally {
    blocker.stop(true);
  }
}, 15_000);
