/**
 * Bug #76 - worker event 'ready' does not work anymore
 * https://github.com/egeominotti/bunqueue/issues/76
 *
 * When a Worker is constructed with default options (autorun: true) and the
 * 'ready' listener is attached *after* the constructor returns (e.g. via
 * method chaining), the listener never fires.
 *
 * Root cause: run() is called synchronously inside the constructor and emits
 * 'ready' before the caller has a chance to subscribe.
 *
 * Repro from the issue:
 *   const worker = new Worker('test-wo', (job) => {})
 *     .on('ready', () => console.log('ready!'))
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue } from '../src/client/queue';
import { Worker } from '../src/client/worker';

describe("Bug #76 - Worker 'ready' event with chained listener", () => {
  let worker: Worker | null = null;

  afterEach(async () => {
    if (worker) {
      await worker.close(true);
      worker = null;
    }
  });

  test("emits 'ready' when listener is chained after construction (default autorun)", async () => {
    let readyEmitted = false;

    worker = new Worker('bug-76-chained', () => {}, { embedded: true }).on('ready', () => {
      readyEmitted = true;
    });

    // Listener was attached synchronously after construction. Give the
    // event loop a tick so any deferred emit has a chance to fire.
    await Bun.sleep(50);

    expect(readyEmitted).toBe(true);
  });

  test("emits 'ready' when .on() is called on a separate statement after construction", async () => {
    let readyEmitted = false;

    worker = new Worker('bug-76-separate', () => {}, { embedded: true });
    worker.on('ready', () => {
      readyEmitted = true;
    });

    await Bun.sleep(50);

    expect(readyEmitted).toBe(true);
  });

  test("still emits 'ready' once when listener is attached BEFORE run() with autorun:false", async () => {
    let readyCount = 0;

    worker = new Worker('bug-76-autorun-false', () => {}, {
      embedded: true,
      autorun: false,
    });

    worker.on('ready', () => {
      readyCount++;
    });

    worker.run();

    await Bun.sleep(50);

    expect(readyCount).toBe(1);
  });

  test('full lifecycle events fire when listeners are chained after construction', async () => {
    // This test proves that the chained-after-construction pattern works for
    // all the main lifecycle events, not just 'ready'. None of the other
    // events were emitted synchronously from the constructor, so they should
    // all work — this is a regression guard to keep it that way.
    const seen = {
      ready: false,
      active: false,
      completed: false,
      drained: false,
      closed: false,
    };

    const queue = new Queue('bug-76-lifecycle', { embedded: true });
    await queue.add('task', { value: 1 });

    worker = new Worker('bug-76-lifecycle', async () => ({ ok: true }), { embedded: true })
      .on('ready', () => {
        seen.ready = true;
      })
      .on('active', () => {
        seen.active = true;
      })
      .on('completed', () => {
        seen.completed = true;
      })
      .on('drained', () => {
        seen.drained = true;
      })
      .on('closed', () => {
        seen.closed = true;
      });

    // Wait for the job to be picked up, processed, and the queue to drain.
    const deadline = Date.now() + 3000;
    while (
      (!seen.ready || !seen.active || !seen.completed || !seen.drained) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }

    await worker.close();
    worker = null;
    await queue.close();

    expect(seen.ready).toBe(true);
    expect(seen.active).toBe(true);
    expect(seen.completed).toBe(true);
    expect(seen.drained).toBe(true);
    expect(seen.closed).toBe(true);
  });
});
