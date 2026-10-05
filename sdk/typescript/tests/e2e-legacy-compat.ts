/**
 * E2E: 0.2.2 compatibility of the legacy entry's options, against a real broker.
 *
 * 0.2.3 validates options where they enter. Values 0.2.2 handled without a hot loop, a
 * hang or an immediate timeout must still construct and behave as in 0.2.2: numeric
 * strings, fractional pool sizes, a negative `maxInFlight`, `null` wait TTLs, a zero
 * ACK batch size, and the Simple Mode values listed in tests/legacy-compat-*.test.ts.
 */

import { Bunqueue, CommandTimeoutError, ConnectionPool, Queue, Worker } from '../dist/legacy.js';
import { assert, assertEq, getPort, namedQueue, qname, test, waitFor } from './harness.ts';

const loose = (value: unknown) => value as number;

test('compat: string and fractional connection options run real commands', async () => {
  const name = qname('compat-conn');
  const pooled = new Queue(name, {
    host: '127.0.0.1',
    port: getPort(),
    poolSize: 1.5,
    maxInFlight: -1,
    commandTimeoutMs: loose('5000'),
  });
  const stringPool = new Queue(name, { host: '127.0.0.1', port: getPort(), poolSize: loose('2') });
  try {
    assert(pooled.connection instanceof ConnectionPool, 'poolSize 1.5 builds a pool (0.2.2)');
    assertEq((pooled.connection as ConnectionPool).size, 1, 'poolSize 1.5 is floored to 1');
    assertEq((stringPool.connection as ConnectionPool).size, 2, 'poolSize "2" is 2');
    const added = await Promise.all([1, 2, 3].map((i) => pooled.add('t', { i })));
    await stringPool.add('t', { i: 4 });
    assertEq(added.length, 3, 'unbounded maxInFlight admits concurrent adds');
    await waitFor(async () => (await pooled.getJobCounts()).waiting === 4);
  } finally {
    await pooled.obliterate();
    pooled.close();
    stringPool.close();
  }
});

test('compat: a Worker with numeric-string options and maxSize-0 ACK batches completes', async () => {
  const name = qname('compat-worker');
  const queue = namedQueue(name);
  const worker = new Worker(name, async () => 'done', {
    host: '127.0.0.1',
    port: getPort(),
    concurrency: loose('2'),
    pollTimeoutMs: loose('300'),
    batchSize: loose('5'),
    heartbeatIntervalS: loose('10'),
    ackBatch: { enabled: true, maxSize: 0, maxDelayMs: -1 },
  });
  worker.on('error', () => {});
  try {
    assertEq(worker.pollTimeoutMs, 300, 'pollTimeoutMs "300" is 300');
    assertEq(worker.batchSize, 10, 'a non-number batchSize means 10, as in 0.2.2');
    await worker.waitUntilReady();
    const jobs = await Promise.all([1, 2, 3].map((i) => queue.add('t', { i })));
    await waitFor(async () => (await queue.getJobCounts()).completed === 3, 10_000);
    assertEq(await queue.waitForJob(jobs[0].id, loose('5000')), 'done', 'ttl "5000" waits');
  } finally {
    await worker.close();
    await queue.obliterate();
    queue.close();
  }
});

test('compat: waitForJob(id, null) answers at once, as a zero hold', async () => {
  const queue = namedQueue(qname('compat-wait'));
  try {
    const job = await queue.add('t', { x: 1 });
    const started = Date.now();
    let error: unknown;
    try {
      await queue.waitForJob(job.id, loose(null));
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof CommandTimeoutError, 'an unfinished job times out at once');
    assert((error as Error).message.includes('after 0ms'), `got "${(error as Error).message}"`);
    assert(Date.now() - started < 3000, 'a null ttl does not hold for the 30 s default');
  } finally {
    await queue.obliterate();
    queue.close();
  }
});

test('compat: Simple Mode 0.2.2 values (maxAttempts 0, linear, threshold 0, null heartbeat)', async () => {
  let calls = 0;
  const transitions: string[] = [];
  const app = new Bunqueue(qname('compat-simple'), {
    connection: { host: '127.0.0.1', port: getPort() },
    pollTimeout: loose('300'),
    heartbeatInterval: loose(null),
    processor: async () => {
      calls += 1;
      throw new Error('always');
    },
    retry: { maxAttempts: 0, strategy: 'linear' as never, delay: -1 },
    circuitBreaker: { threshold: 0, resetTimeout: 60_000, onOpen: () => transitions.push('open') },
  });
  const failed: string[] = [];
  app.on('failed', ((_job: unknown, error: Error) => failed.push(error.message)) as never);
  app.on('error', (() => {}) as never);
  try {
    assertEq(app.worker.heartbeatIntervalS, 0, 'heartbeatInterval null disables heartbeats');
    assertEq(app.worker.pollTimeoutMs, 300, 'pollTimeout "300" is 300');
    await app.add('job', {}, { attempts: 1 });
    await waitFor(() => failed.length === 1, 10_000);
    assertEq(calls, 1, 'maxAttempts 0 runs the processor once');
    assertEq(app.getCircuitState(), 'open', 'threshold 0 opens on the first failure');
    assertEq(transitions.join(','), 'open', 'onOpen fired once');
  } finally {
    await app.close();
  }
});

test('compat: Simple Mode batch size 0 processes every job on its own', async () => {
  const flushes: number[] = [];
  const app = new Bunqueue<{ i: number }, string>(qname('compat-batch'), {
    connection: { host: '127.0.0.1', port: getPort() },
    pollTimeout: 300,
    concurrency: 5,
    batch: {
      size: 0,
      timeout: Number.NaN,
      processor: async (jobs) => {
        flushes.push(jobs.length);
        return jobs.map(() => 'ok');
      },
    },
  });
  let completed = 0;
  app.on('completed', (() => {
    completed += 1;
  }) as never);
  try {
    await Promise.all([0, 1, 2].map((i) => app.add('b', { i })));
    await waitFor(() => completed === 3, 10_000);
    assertEq(flushes.join(','), '1,1,1', 'size 0 flushes each job at once (0.2.2)');
  } finally {
    await app.close();
  }
});
