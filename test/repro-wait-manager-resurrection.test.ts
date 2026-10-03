import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents, shutdownManager } from '../src/client';
import { peekSharedManager } from '../src/client/manager';

// A pending wait must never re-create the embedded QueueManager after shutdownManager():
// the new manager keeps timers alive (the process never exits) and answers from an empty
// database ("Job ... not found"). Found by the skeptic review of the first jobWait.ts:
// its state reads called getSharedManager() after the readiness gate.

setDefaultTimeout(20_000);

let dir = '';

afterEach(() => {
  peekSharedManager()?.shutdown();
  shutdownManager();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function freshDataPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'repro-resurrect-'));
  return join(dir, 'q.db');
}

/** The wait's outcome, or 'pending' when it has not settled within `ms`. */
function settledWithin(wait: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    wait.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: (error as Error).message })
    ),
    Bun.sleep(ms).then(() => 'pending'),
  ]);
}

test('a wait in progress at shutdownManager() does not resurrect the shared manager', async () => {
  const dataPath = freshDataPath();
  const queue = new Queue('s', { embedded: true, dataPath });
  const events = new QueueEvents('s', { embedded: true, dataPath });
  const job = await queue.add('j', {});

  const wait = queue.waitJobUntilFinished(job.id, events, 500).catch((e: Error) => e);
  events.close();
  await queue.close();
  shutdownManager();

  await wait;
  expect(peekSharedManager()).toBeNull();
});

test('a wait started after shutdownManager() rejects without creating a manager', async () => {
  const dataPath = freshDataPath();
  const queue = new Queue('s', { embedded: true, dataPath });
  const job = await queue.add('j', {});
  await queue.close();
  shutdownManager();

  const started = Date.now();
  expect(await settledWithin(job.waitUntilFinished(null, 3_000), 5_000)).toEqual({
    error: 'waitUntilFinished: the embedded engine was shut down',
  });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(peekSharedManager()).toBeNull();
});

test('a wait without a TTL settles as soon as shutdownManager() stops the engine', async () => {
  const dataPath = freshDataPath();
  const queue = new Queue('s', { embedded: true, dataPath });
  const events = new QueueEvents('s', { embedded: true, dataPath });
  const job = await queue.add('j', {});
  // A TTL of 0 means no timeout, with or without QueueEvents.
  const waits = [job.waitUntilFinished(events), job.waitUntilFinished(null, 0)].map((wait) =>
    settledWithin(wait, 2_000)
  );
  await Bun.sleep(20);

  shutdownManager();

  expect(await Promise.all(waits)).toEqual([
    { error: 'waitUntilFinished: the embedded engine was shut down' },
    { error: 'waitUntilFinished: the embedded engine was shut down' },
  ]);
  expect(peekSharedManager()).toBeNull();
});

test('the process exits when a wait starts after shutdownManager()', async () => {
  const dataPath = freshDataPath();
  const script = join(dir, 'wait-after-shutdown.ts');
  const client = join(import.meta.dir, '../src/client/index.ts');
  writeFileSync(
    script,
    `import { Queue, shutdownManager } from ${JSON.stringify(client)};
const queue = new Queue('s', { embedded: true, dataPath: ${JSON.stringify(dataPath)} });
const job = await queue.add('j', {});
await queue.close();
shutdownManager();
await job.waitUntilFinished(null, 3000).catch((error) => console.log('settled:', error.message));
`
  );
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'still running')]);
  if (exited === 'still running') child.kill(9);

  expect(exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain(
    'settled: waitUntilFinished: the embedded engine was shut down'
  );
});
