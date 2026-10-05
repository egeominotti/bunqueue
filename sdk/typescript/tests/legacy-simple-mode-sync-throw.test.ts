/**
 * Legacy entry: Simple Mode cleanup when a processor (or a breaker hook) throws.
 *
 * Mirrors test/repro-bunqueue-sync-throw-cancellation.test.ts of the main client. A
 * processor that threw before returning a Promise skipped the pipeline's settle
 * handlers: the circuit breaker never counted the failure and the job's cancellation
 * registration was never released. A throwing breaker hook skipped the release too.
 */

import { describe, expect, test } from 'bun:test';
import { Bunqueue } from '../src/bunqueue/bunqueue.js';
import type { BunqueueOptions } from '../src/bunqueue/types.js';
import type { Job } from '../src/job.js';

interface Internals {
  processJob(job: Job<unknown>): Promise<unknown>;
  cancellation: {
    currentByJob: Map<string, unknown>;
    registrations: Map<AbortController, unknown>;
  };
}

function internals(app: Bunqueue): Internals {
  return app as unknown as Internals;
}

function job(id: string): Job<unknown> {
  return { id, name: 'fail', data: {}, timestamp: Date.now() } as unknown as Job<unknown>;
}

function expectReleased(app: Bunqueue, jobId: string): void {
  expect(app.getSignal(jobId)).toBeNull();
  expect(internals(app).cancellation.currentByJob.size).toBe(0);
  expect(internals(app).cancellation.registrations.size).toBe(0);
}

async function withApp(options: BunqueueOptions, run: (app: Bunqueue) => Promise<void>) {
  const app = new Bunqueue('sync-throw', { autorun: false, ...options });
  try {
    await run(app);
  } finally {
    await app.close(true);
  }
}

describe('Simple Mode synchronous throw cleanup', () => {
  test('without retry: the breaker counts it and the cancellation is released', async () => {
    const processor = () => {
      throw new Error('synchronous processor failure');
    };
    await withApp({ processor, circuitBreaker: { threshold: 1 } }, async (app) => {
      await expect(internals(app).processJob(job('j1'))).rejects.toThrow(
        'synchronous processor failure'
      );
      expect(app.getCircuitState()).toBe('open');
      expectReleased(app, 'j1');
    });
  });

  test('a synchronous throw from a middleware is handled the same way', async () => {
    await withApp(
      { processor: async () => 'ok', circuitBreaker: { threshold: 1 } },
      async (app) => {
        app.use(() => {
          throw new Error('synchronous middleware failure');
        });
        await expect(internals(app).processJob(job('j2'))).rejects.toThrow(
          'synchronous middleware failure'
        );
        expect(app.getCircuitState()).toBe('open');
        expectReleased(app, 'j2');
      }
    );
  });

  test('a throwing circuit-breaker hook cannot bypass the cancellation release', async () => {
    const options: BunqueueOptions = {
      processor: async () => {
        throw new Error('processor failure');
      },
      circuitBreaker: {
        threshold: 1,
        onOpen: () => {
          throw new Error('user circuit-breaker hook failure');
        },
      },
    };
    await withApp(options, async (app) => {
      await expect(internals(app).processJob(job('j3'))).rejects.toThrow();
      expectReleased(app, 'j3');
    });
  });

  test('with retry: synchronous throws are retried and the generation released', async () => {
    let calls = 0;
    const processor = () => {
      calls += 1;
      if (calls < 3) throw new Error('retry this synchronous failure');
      return { ok: true };
    };
    const retry = { maxAttempts: 3, delay: 0, strategy: 'fixed' as const };
    await withApp({ processor, retry }, async (app) => {
      expect(await internals(app).processJob(job('j4'))).toEqual({ ok: true });
      expect(calls).toBe(3);
      expectReleased(app, 'j4');
    });
  });
});
