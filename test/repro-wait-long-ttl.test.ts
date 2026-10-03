import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueEvents } from '../src/client';
import { CoreE2eHarness } from './core-e2e/support/harness';

// A wait TTL longer than the runtime's timer limit (2^31 - 1 ms, about 24.8 days)
// gave up almost at once. Found while reviewing the bunqueue 2.9.9 release: the wait
// armed its deadline with one `setTimeout(ttl)`, and Bun, like Node.js, prints a
// TimeoutOverflowWarning and fires such a timer after 1 ms. So
// `waitJobUntilFinished(id, events, 30 days)` made one last state read and, with the
// job still waiting, rejected with "timed out after 2592000000ms" within milliseconds.
// A TTL is a deadline: it must hold for as long as the caller asked.

setDefaultTimeout(30_000);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function queueEvents(h: CoreE2eHarness, name: string): QueueEvents {
  const events = new QueueEvents(
    name,
    h.mode === 'tcp'
      ? { embedded: false, connection: h.connection() }
      : { embedded: true, dataPath: h.dataPath }
  );
  h.addCleanup(() => events.close());
  return events;
}

/** Settles to 'pending' if `promise` has not settled within `ms`. */
async function stateAfter(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
    ),
    Bun.sleep(ms).then(() => pending),
  ]);
  return outcome === pending ? 'pending' : outcome;
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`a wait with a TTL beyond the timer limit [${mode}]`, () => {
    for (const withEvents of [true, false]) {
      const label = withEvents ? 'with QueueEvents' : 'without QueueEvents';

      test(`keeps waiting and resolves when the job completes (${label})`, async () => {
        harness = await CoreE2eHarness.start(mode, `wait-long-ttl-${withEvents ? 'qe' : 'plain'}`);
        const h = harness;
        const queue = h.queue('long-ttl');
        const events = withEvents ? queueEvents(h, queue.name) : null;
        await events?.waitUntilReady();
        const warnings: string[] = [];
        const onWarning = (warning: Error) => warnings.push(warning.name);
        process.on('warning', onWarning);
        h.addCleanup(() => {
          process.off('warning', onWarning);
        });

        const job = await queue.add('slow', { n: 1 }, { durable: true });
        const wait = queue.waitJobUntilFinished(job.id, events, THIRTY_DAYS_MS);

        // No worker yet: the job is waiting, so the wait must still be pending.
        expect(await stateAfter(wait, 500)).toBe('pending');
        expect(warnings).not.toContain('TimeoutOverflowWarning');

        h.worker(queue.name, async () => ({ done: true }));
        expect(await wait).toEqual({ done: true });
      });
    }
  });
}
