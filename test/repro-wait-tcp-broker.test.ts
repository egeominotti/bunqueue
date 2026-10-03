import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Queue, TcpConnectionPool } from '../src/client';
import { CoreE2eHarness } from './core-e2e/support/harness';

// Over TCP without QueueEvents, `job.waitUntilFinished(null, ttl)` waits through the
// broker's WaitJob command, which settles only on completion. Found by the skeptic
// review of the first jobWait.ts:
// - a job that had already failed held the caller for the whole TTL (a 5s TTL rejected
//   after 5002 ms), and one failing during the wait was reported only at the TTL;
// - WaitJob ran under the connection's command timeout, so a TTL at or above it (the
//   defaults are both 30s) rejected with "Command timeout", three such timeouts forced
//   a reconnect that failed every in-flight command, and a TTL above the broker's
//   600000 ms bound was rejected by the broker.
// Durations are asserted with margins that survive a loaded CI container.

setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function outcome(wait: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  return wait.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message })
  );
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error('condition not reached within 10s');
}

function pool(queue: Queue): TcpConnectionPool {
  return (queue as unknown as { tcpPool: TcpConnectionPool }).tcpPool;
}

describe('job.waitUntilFinished without QueueEvents over TCP', () => {
  test('a job that already failed settles at once, not at the TTL', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-tcp-failed');
    const queue = harness.queue('doomed');
    harness.worker(queue.name, () => {
      throw new Error('boom');
    });
    const job = await queue.add('doomed', {}, { attempts: 1, durable: true });
    await until(async () => (await queue.getJobState(job.id)) === 'failed');

    const started = performance.now();
    expect(await outcome(job.waitUntilFinished(null, 5_000))).toEqual({ error: 'boom' });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test('a job that fails during the wait is reported long before the TTL', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-tcp-late-failure');
    const queue = harness.queue('late');
    const job = await queue.add('late', {}, { attempts: 1, durable: true });

    const started = performance.now();
    const wait = outcome(job.waitUntilFinished(null, 20_000));
    harness.worker(queue.name, async () => {
      await Bun.sleep(200);
      throw new Error('late failure');
    });

    expect(await wait).toEqual({ error: 'late failure' });
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  test('a TTL longer than the command timeout waits for a job that completes later', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-tcp-slow');
    const queue = harness.queue('slow', { connection: { commandTimeout: 1_000 } });
    harness.worker(queue.name, async () => {
      await Bun.sleep(1_500);
      return 'done';
    });
    const job = await queue.add('slow', {}, { durable: true });

    expect(await outcome(job.waitUntilFinished(null, 6_000))).toEqual({ value: 'done' });
  });

  test('a wait that outlives the command timeout rejects with its own timeout and keeps the connection', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-tcp-idle');
    const queue = harness.queue('idle', { connection: { commandTimeout: 1_000 } });
    // No worker: the jobs never finish. Three waits at once would be three consecutive
    // command timeouts, the default threshold for a forced reconnect.
    const jobs = await Promise.all(
      [1, 2, 3].map((i) => queue.add('idle', { i }, { durable: true }))
    );

    const started = performance.now();
    const outcomes = await Promise.all(
      jobs.map((job) => outcome(job.waitUntilFinished(null, 2_500)))
    );
    const elapsed = performance.now() - started;

    expect(outcomes).toEqual(
      jobs.map(() => ({ error: 'waitUntilFinished timed out after 2500ms' }))
    );
    expect(elapsed).toBeGreaterThanOrEqual(2_450);
    expect(elapsed).toBeLessThan(6_000);
    const health = pool(queue).getHealth();
    expect(health.connectedCount).toBe(1);
    expect(health.clients[0].consecutiveCommandTimeouts).toBe(0);
    expect(await queue.getJobState(jobs[0].id)).toBe('waiting');
  });

  test('a TTL above the broker bound of 600000 ms still waits for the job', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-tcp-long-ttl');
    const queue = harness.queue('long');
    harness.worker(queue.name, async () => {
      await Bun.sleep(200);
      return 'done';
    });
    const job = await queue.add('long', {}, { durable: true });

    expect(await outcome(job.waitUntilFinished(null, 700_000))).toEqual({ value: 'done' });
  });
});
