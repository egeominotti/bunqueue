/**
 * `runServer` (test/config-test-support.ts) picks its ports with `freePort()`,
 * which binds port 0, reads the number and releases it before the child server
 * binds. Under `bun test --parallel=4` another worker can take that port in the
 * gap: the child then exits 1 with "Failed to listen", and a test that expects a
 * running server (repro-config-fatal-errors: "inputs 2.9.10 ran with keep the
 * server running") fails although the configuration is fine.
 *
 * The race is made deterministic here by handing the first launch a port that
 * is already held. A lost race on ports runServer chose itself must be retried
 * with fresh ports; ports the caller pinned are never silently replaced.
 */
import { afterAll, expect, test } from 'bun:test';
import { freePort, makeSandbox, runServer, type Sandbox } from './config-test-support';

const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});
function sandbox(): Sandbox {
  const created = makeSandbox('bunqueue-port-race-');
  sandboxes.push(created);
  return created;
}

function holdPort(): { port: number; release(): void } {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  return { port: listener.port, release: () => listener.stop(true) };
}

// No killWhen: the startup banner (Shards, ...) is printed before the listeners
// bind, so a banner match would kill the first launch before it can fail with
// "Failed to listen". A healthy server simply runs until the deadline instead.

test('a lost race for a port runServer picked is retried with fresh ports', async () => {
  const held = holdPort();
  try {
    let calls = 0;
    const pickPort = () => (++calls === 1 ? held.port : freePort());
    const run = await runServer(sandbox(), { killAfterMs: 4_000, pickPort });
    expect({
      exitCode: run.exitCode,
      listenFailureInFinalRun: /Failed to listen/i.test(run.output),
    }).toEqual({
      exitCode: null,
      listenFailureInFinalRun: false,
    });
    expect(calls).toBeGreaterThan(2);
  } finally {
    held.release();
  }
}, 30_000);

test('a port the caller pinned is not replaced when it is taken', async () => {
  const held = holdPort();
  try {
    const run = await runServer(sandbox(), {
      env: { TCP_PORT: String(held.port) },
      killAfterMs: 10_000,
    });
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/Failed to listen/i);
  } finally {
    held.release();
  }
}, 30_000);
