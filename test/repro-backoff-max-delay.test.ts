/**
 * Repro: backoff.maxDelay is part of the job model and calculateBackoff reads it,
 * but createJob rebuilt the backoff config as { type, delay } and dropped it.
 * The Rust, Python and legacy TypeScript SDKs send maxDelay, so their callers
 * silently kept the 1-hour default cap. Once the value is kept, the server must
 * also validate it, or a malformed value would turn retry delays into NaN.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { calculateBackoff } from '../src/domain/job/state';
import type { Job } from '../src/domain/types/job';
import { validateBackoffField } from '../src/infrastructure/server/protocol/validation';

const backoff = { type: 'exponential', delay: 1_000, maxDelay: 5_000 } as const;

let manager: QueueManager | undefined;
let directory: string | undefined;

afterEach(() => {
  manager?.shutdown();
  manager = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('backoff.maxDelay', () => {
  test('a pushed job keeps maxDelay and its retry delay never exceeds it', async () => {
    manager = new QueueManager();
    const pushed = await manager.push('retry', { data: {}, backoff } as never);
    const job = await manager.getJob(pushed.id);

    expect(job?.backoffConfig?.maxDelay).toBe(5_000);

    // Without the cap, attempt 10 would wait about 1000 * 2^10 ms.
    const late = { ...job!, attempts: 10 } as Job;
    for (let sample = 0; sample < 50; sample++) {
      expect(calculateBackoff(late)).toBeLessThanOrEqual(5_000);
    }
  });

  test('maxDelay survives a SQLite restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'bunqueue-backoff-max-delay-'));
    const dataPath = join(directory, 'queue.db');

    manager = new QueueManager({ dataPath });
    const pushed = await manager.push('retry', { data: {}, backoff, durable: true } as never);
    manager.shutdown();

    manager = new QueueManager({ dataPath });
    const restored = await manager.getJob(pushed.id);
    expect(restored?.backoffConfig?.maxDelay).toBe(5_000);
  });

  test('the server validates maxDelay instead of accepting any value', () => {
    expect(validateBackoffField(backoff)).toBeNull();
    expect(
      validateBackoffField({ type: 'exponential', delay: 1_000, maxDelay: -1 })
    ).not.toBeNull();
    expect(
      validateBackoffField({ type: 'exponential', delay: 1_000, maxDelay: 'soon' })
    ).not.toBeNull();
  });
});
