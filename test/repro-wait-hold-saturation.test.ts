import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';

// Found by the skeptic review of the v2 job wait: the broker runs at most 50 commands
// per connection at once, and every TCP wait without QueueEvents held a WaitJob, so more
// than ~50 such waits on one connection took every slot. Other commands on the pool then
// waited for a hold to end (a getJobCounts probe took up to 10 s), and the queued holds
// overran their own timeout, which forced reconnects that failed every wait with
// "Connection lost" (HEAD fails the same way). Holds are now capped per connection pool;
// the other waits rely on state reads.
// `embedded: false` is explicit: the test preload sets BUNQUEUE_EMBEDDED=1.

setDefaultTimeout(60_000);

let dir = '';
let manager: QueueManager | null = null;
let server: TcpServer | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  server?.stop();
  manager?.shutdown();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('100 waits without QueueEvents leave the connection usable and all complete', async () => {
  dir = mkdtempSync(join(tmpdir(), 'wait-saturation-'));
  manager = new QueueManager({ dataPath: join(dir, 'q.db') });
  server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  const connection = { host: '127.0.0.1', port: server.server.port, poolSize: 1 };
  const queue = new Queue('saturation', {
    embedded: false,
    connection,
    autoBatch: { enabled: false },
  });
  cleanups.push(() => queue.close());
  const jobs = await queue.addBulk(
    Array.from({ length: 100 }, (_, i) => ({ name: 'job', data: { i } }))
  );

  const waits = jobs.map((job) =>
    job.waitUntilFinished(null, 40_000).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: (error as Error).message })
    )
  );
  // Once holds are 8 s long, a command on the same pool must not queue behind them.
  await Bun.sleep(9_000);
  const probeStarted = performance.now();
  await queue.getJobCounts();
  const probeMs = performance.now() - probeStarted;

  const worker = new Worker('saturation', () => 'done', {
    embedded: false,
    connection: { ...connection, poolSize: 1 },
    concurrency: 20,
  });
  cleanups.push(() => worker.close(true));

  expect(await Promise.all(waits)).toEqual(jobs.map(() => ({ value: 'done' })));
  expect(probeMs).toBeLessThan(1_000);
});
