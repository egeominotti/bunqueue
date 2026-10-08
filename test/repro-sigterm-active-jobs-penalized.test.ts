/**
 * REPRO — a graceful SIGTERM restart charges jobs that never failed.
 *
 * Run: bun test test/repro-sigterm-active-jobs-penalized.test.ts
 *
 * Two defects combine on every graceful restart of a TCP broker:
 *
 * 1. Shutdown order (src/infrastructure/server/shutdownCoordinator.ts): the TCP and
 *    HTTP listeners stop BEFORE the active-job drain, so a worker can never ACK the
 *    job it is running. The drain then waits the whole SHUTDOWN_TIMEOUT_MS (30 s by
 *    default, longer than `docker stop`'s 10 s) for ACKs that cannot arrive, and the
 *    row stays `active` on disk. docs/features/tcp-server-handlers.md describes the
 *    drain as waiting for active jobs to finish.
 *
 * 2. Disconnect release (src/application/clientTracking.ts `releaseJobToQueue`):
 *    when a worker connection closes, its job goes back to `waiting` in memory only.
 *    SQLite still says `active`.
 *
 * Startup recovery (src/application/background/recovery/active.ts) treats every
 * `active` row as a stall: attempts + 1 and stallCount + 1, and a job whose attempts
 * are exhausted goes to the DLQ. Measured with the real SDK: a job with attempts: 1
 * whose processor SUCCEEDED during shutdown is `failed` in the DLQ after restart, and
 * a job with attempts: 3 is `delayed` with one attempt charged and will run again.
 *
 * Contract pinned here:
 * - a job a worker finishes during the shutdown drain is `completed` after restart,
 *   and the drain ends as soon as no job is active instead of running out the clock;
 * - a job released by a disconnecting worker is `waiting` after a graceful restart,
 *   with no attempt charged and no DLQ entry.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TcpClient } from '../src/client/tcp/client';

type Subprocess = ReturnType<typeof Bun.spawn>;

const QUEUE = 'payments';
const SHUTDOWN_TIMEOUT_MS = 10_000;

let dir = '';
let server: Subprocess | null = null;
const clients: TcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      client.close();
    } catch {
      // already closed by the broker
    }
  }
  if (server) {
    server.kill('SIGKILL');
    await server.exited;
    server = null;
  }
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitPort(port: number, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
      socket.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`server not ready on :${port}`);
}

/** Start the real broker on a fresh port against `db`. */
async function startServer(db: string): Promise<number> {
  const port = freePort();
  server = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      BUNQUEUE_EMBEDDED: '',
      TCP_PORT: String(port),
      HTTP_PORT: '0',
      BUNQUEUE_DATA_PATH: db,
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
      LOG_LEVEL: 'error',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitPort(port);
  return port;
}

/** Send SIGTERM and wait for the broker to finish its graceful shutdown. */
async function terminate(): Promise<{ code: number; elapsedMs: number }> {
  const proc = server!;
  const startedAt = Date.now();
  proc.kill('SIGTERM');
  const code = await proc.exited;
  server = null;
  return { code, elapsedMs: Date.now() - startedAt };
}

async function connect(port: number): Promise<TcpClient> {
  const client = new TcpClient({
    host: '127.0.0.1',
    port,
    autoReconnect: false,
    pingInterval: 0,
    commandTimeout: 5_000,
    connectTimeout: 5_000,
  });
  await client.connect();
  clients.push(client);
  return client;
}

async function pushAndPull(port: number, attempts: number) {
  const producer = await connect(port);
  const push = await producer.send({
    cmd: 'PUSH',
    queue: QUEUE,
    data: { amount: 10 },
    maxAttempts: attempts,
    durable: true,
  });
  const id = String(push.id);
  const worker = await connect(port);
  const pull = await worker.send({ cmd: 'PULL', queue: QUEUE, owner: 'w', lockTtl: 60_000 });
  expect((pull.job as { id: string } | null)?.id).toBe(id);
  return { id, token: pull.token as string, worker };
}

async function inspect(port: number, id: string) {
  const client = await connect(port);
  const state = (await client.send({ cmd: 'GetState', queue: QUEUE, id })).state;
  const job = (await client.send({ cmd: 'GetJob', id })).job as { attempts?: number } | null;
  const dlq = (await client.send({ cmd: 'Dlq', queue: QUEUE })).jobs as unknown[] | undefined;
  return { state, attempts: job?.attempts, dlqSize: dlq?.length ?? 0 };
}

describe('graceful SIGTERM restart of a TCP broker', () => {
  test('a job its worker finishes during the drain is completed after restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bq-sigterm-drain-'));
    const db = join(dir, 'bunq.db');
    let port = await startServer(db);
    const { id, token, worker } = await pushAndPull(port, 1);

    const shutdown = terminate();
    await Bun.sleep(300);
    const ack = await worker
      .send({ cmd: 'ACK', id, token, result: { charged: true } })
      .catch((error: unknown) => ({ ok: false, error: String(error) }));
    const { code, elapsedMs } = await shutdown;

    expect(ack.ok).toBe(true);
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS / 2);

    port = await startServer(db);
    expect(await inspect(port, id)).toEqual({ state: 'completed', attempts: 0, dlqSize: 0 });
  }, 90_000);

  test('a job released by a disconnecting worker keeps its attempts across a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bq-sigterm-release-'));
    const db = join(dir, 'bunq.db');
    let port = await startServer(db);
    const { id, worker } = await pushAndPull(port, 1);

    worker.close();
    const deadline = Date.now() + 5_000;
    let live = await inspect(port, id);
    while (live.state !== 'waiting' && Date.now() < deadline) {
      await Bun.sleep(50);
      live = await inspect(port, id);
    }
    expect(live.state).toBe('waiting');

    const { code } = await terminate();
    expect(code).toBe(0);

    port = await startServer(db);
    expect(await inspect(port, id)).toEqual({ state: 'waiting', attempts: 0, dlqSize: 0 });
  }, 90_000);
});
