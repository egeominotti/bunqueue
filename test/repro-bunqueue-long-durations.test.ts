/**
 * Repro, real runtime: Simple Mode durations longer than the native timer limit
 * (2^31 - 1 ms, about 24.8 days) fired after about 1 ms with a TimeoutOverflowWarning:
 * a 30-day batch timeout flushed at once, a 30-day circuit reset half-opened at once,
 * a 30-day cancel grace aborted at once, a 30-day retry backoff retried at once, and a
 * 30-day aging interval ticked about 870 times a second. In a fresh Bun process (Bun
 * prints each warning once per process), each must wait, and close() must leave no
 * timer that keeps the process alive.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runScript } from './shared-timers-support';

const client = JSON.stringify(join(import.meta.dir, '..', 'src', 'client', 'index.ts'));

const script = `
import { Bunqueue, shutdownManager } from ${client};

const LONG = 30 * 86_400_000;
const tag = String(process.pid);
const common = { embedded: true, heartbeatInterval: 0 };
const counts = { batchFlushes: 0, retryAttempts: 0, agingTicks: 0 };

const batch = new Bunqueue('long-batch-' + tag, {
  ...common,
  concurrency: 5,
  batch: {
    size: 10,
    timeout: LONG,
    processor: async (jobs) => {
      counts.batchFlushes++;
      return jobs.map(() => null);
    },
  },
});
const circuit = new Bunqueue('long-circuit-' + tag, {
  ...common,
  processor: async () => {
    throw new Error('downstream is down');
  },
  circuitBreaker: { threshold: 1, resetTimeout: LONG },
});
const cancellable = new Bunqueue('long-cancel-' + tag, {
  ...common,
  processor: () => new Promise(() => {}),
});
const retrying = new Bunqueue('long-retry-' + tag, {
  ...common,
  processor: async () => {
    counts.retryAttempts++;
    throw new Error('still down');
  },
  retry: { maxAttempts: 3, strategy: 'custom', customBackoff: () => LONG },
});
const aging = new Bunqueue('long-aging-' + tag, {
  ...common,
  autorun: false,
  processor: async () => null,
  priorityAging: { interval: LONG },
});
const agingQueue = aging.queue;
const waiting = agingQueue.getWaitingAsync.bind(agingQueue);
agingQueue.getWaitingAsync = (...args) => {
  counts.agingTicks++;
  return waiting(...args);
};

const active = new Promise((resolve) => cancellable.once('active', resolve));
await batch.add('row', {});
await circuit.add('trip', {}, { attempts: 1 });
const job = await cancellable.add('encode', {});
await retrying.add('call', {}, { attempts: 1 });
await active;
cancellable.cancel(job.id, LONG);

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  if (circuit.getCircuitState() !== 'closed' && counts.retryAttempts > 0) break;
  await Bun.sleep(5);
}
await Bun.sleep(150);

console.log('RESULT ' + JSON.stringify({
  ...counts,
  circuit: circuit.getCircuitState(),
  cancelled: cancellable.isCancelled(job.id),
}));
await Promise.all([batch, circuit, cancellable, retrying, aging].map((app) => app.close(true)));
shutdownManager();
`;

test('30-day Simple Mode durations wait in a real Bun process and close() releases them', async () => {
  const { exited, output } = await runScript(script);
  expect(output).not.toMatch(/Timeout\w*Warning/);
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  expect(line, output).toBeDefined();
  expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
    batchFlushes: 0,
    retryAttempts: 1,
    agingTicks: 0,
    circuit: 'open',
    cancelled: false,
  });
  // A long timer left armed by close() would keep the process alive past runScript's limit.
  expect(exited, output).toBe(0);
}, 30_000);
