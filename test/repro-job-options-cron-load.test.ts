/**
 * Repro: a persisted cron whose template predates the job-option bounds loads silently.
 *
 * `addCron` now rejects template options, priority and `dedup.ttl` values a job cannot
 * run with, and a `repeatEvery` beyond the honoured duration, but a definition stored by
 * an older release is not re-validated on load (that would block startup). It keeps
 * firing with its stored values, so the operator must be told once, at load, which cron
 * is affected and why. A template 2.9.10 ran (a timeout above a day, an interval of 400
 * days) is valid and logs nothing.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { CronJob } from '../src/domain/types/cron';

const dirs: string[] = [];
let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StorageWithCrons {
  saveCron(cron: CronJob): void;
}

describe('persisted cron templates are checked at load', () => {
  test('each invalid template logs one warning naming the cron and the problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-load-'));
    dirs.push(dir);
    const dataPath = join(dir, 'queue.db');
    manager = new QueueManager({ dataPath });
    const storage = (manager as unknown as { storage: StorageWithCrons }).storage;
    const base = manager.addCron({ name: 'valid', queue: 'q', data: {}, repeatEvery: 60_000 });
    // Simulate rows written before the bounds existed.
    storage.saveCron({ ...base, name: 'legacy-timeout', jobOptions: { timeout: -1 } });
    storage.saveCron({ ...base, name: 'legacy-interval', repeatEvery: 5e15 });
    storage.saveCron({ ...base, name: 'still-valid', jobOptions: { timeout: 3e9 } });
    storage.saveCron({ ...base, name: 'still-valid-interval', repeatEvery: 400 * 86_400_000 });
    manager.shutdown();

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager = new QueueManager({ dataPath });
      const lines = warn.mock.calls.map((call) => String(call[0]));
      const cronWarnings = lines.filter((line) => line.includes('Persisted cron'));
      expect(cronWarnings).toHaveLength(2);
      expect(cronWarnings.find((line) => line.includes('"legacy-timeout"'))).toContain(
        'jobOptions.timeout must be at least 0'
      );
      expect(cronWarnings.find((line) => line.includes('"legacy-interval"'))).toContain(
        'Cron repeatEvery must be at most 4320000000000000 milliseconds'
      );
      expect(
        manager
          .listCrons()
          .map((cron) => cron.name)
          .sort()
      ).toEqual([
        'legacy-interval',
        'legacy-timeout',
        'still-valid',
        'still-valid-interval',
        'valid',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
