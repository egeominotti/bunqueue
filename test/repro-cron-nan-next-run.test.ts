/**
 * REPRO — Cron scheduler: a cron whose nextRun is not a finite number (a corrupted
 * persisted row, or a NaN written into a scheduled cron) must not stop the scheduler.
 *
 * Run: bun test test/repro-cron-nan-next-run.test.ts
 *
 * `scheduleNext` (src/infrastructure/scheduler/cron/runtime.ts) arms one timer for the
 * soonest cron through `clampTimerDelay`, which throws a TypeError on NaN, so a NaN at
 * the top of the heap made `load()`/`start()` throw and left every other cron without
 * a timer. Before that, NaN reached `setTimeout`, which fired after 1 ms; `tick` took
 * the NaN as due, fired the job, and an interval cron's next run stayed NaN
 * (NaN + repeatEvery), so the scheduler persisted NaN on every tick.
 *
 * Asserts the explicit handling: the entry is rescheduled from now (as a restart with
 * skipMissedOnRestart does), the repaired nextRun is persisted, it does not fire for
 * the corrupted slot, nothing throws, and the other crons keep firing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createCronJob, type CronJob } from '../src/domain/types/cron';
import { CronScheduler } from '../src/infrastructure/scheduler/cronScheduler';

const HOUR = 60 * 60 * 1000;

describe('REPRO: a cron whose nextRun is not a finite number', () => {
  let scheduler: CronScheduler | null = null;
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => void warnings.push(warning.name);
  process.on('warning', onWarning);

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    warnings.length = 0;
  });

  function harness() {
    const pushes: string[] = [];
    const persisted: Array<{ name: string; nextRun: number }> = [];
    scheduler = new CronScheduler();
    scheduler.setPushCallback(async (queue) => {
      pushes.push(queue);
    });
    scheduler.setPersistCallback((name, _executions, nextRun) => {
      persisted.push({ name, nextRun });
    });
    return { scheduler, pushes, persisted };
  }

  function cron(name: string, repeatEvery: number, nextRun: number): CronJob {
    return createCronJob({ name, queue: `${name}-q`, data: {}, repeatEvery }, nextRun);
  }

  test.each([
    [NaN, 'before start()'],
    [NaN, 'after start()'],
    [Infinity, 'after start()'],
    [-Infinity, 'after start()'],
    [null, 'before start()'],
  ])(
    'a persisted nextRun of %p loaded %s is rescheduled and persisted; others keep firing',
    async (corrupt, order) => {
      const loadFirst = order === 'before start()';
      const { scheduler: s, pushes, persisted } = harness();
      const broken = cron('broken', HOUR, Date.now());
      broken.nextRun = corrupt as number;
      const healthy = cron('healthy', 40, Date.now() + 40);

      if (loadFirst) {
        expect(() => s.load([broken, healthy])).not.toThrow();
        expect(() => s.start()).not.toThrow();
      } else {
        s.start();
        expect(() => s.load([broken, healthy])).not.toThrow();
      }
      const loadedAt = Date.now();
      await Bun.sleep(300);

      expect(pushes.filter((q) => q === 'healthy-q').length).toBeGreaterThanOrEqual(3);
      expect(pushes).not.toContain('broken-q');
      const repaired = s.get('broken')?.nextRun ?? NaN;
      expect(Number.isFinite(repaired)).toBe(true);
      expect(repaired).toBeGreaterThanOrEqual(loadedAt + HOUR - 1_000);
      expect(persisted.filter((p) => p.name === 'broken')).toEqual([
        { name: 'broken', nextRun: repaired },
      ]);
      expect(persisted.every((p) => Number.isFinite(p.nextRun))).toBe(true);
      expect(warnings.filter((name) => name.startsWith('Timeout'))).toEqual([]);
    }
  );

  // An in-place Infinity sorts last and never surfaces while other crons exist; load()
  // repairs it (above). NaN, -Infinity and null reach the top of the heap.
  test.each([NaN, -Infinity, null])(
    'a scheduled cron whose nextRun becomes %p is repaired on the next tick, not fired',
    async (corrupt) => {
      const { scheduler: s, pushes, persisted } = harness();
      s.start();
      s.add({ name: 'healthy', queue: 'healthy-q', data: {}, repeatEvery: 40 });
      const victim = s.add({ name: 'victim', queue: 'victim-q', data: {}, repeatEvery: HOUR });
      // As an in-place write (a replica refresh, a bad migration) would leave it.
      victim.nextRun = corrupt as number;
      const corruptedAt = Date.now();
      await Bun.sleep(300);

      expect(pushes.filter((q) => q === 'healthy-q').length).toBeGreaterThanOrEqual(3);
      expect(pushes).not.toContain('victim-q');
      const repaired = s.get('victim')?.nextRun ?? NaN;
      expect(Number.isFinite(repaired)).toBe(true);
      expect(repaired).toBeGreaterThanOrEqual(corruptedAt + HOUR - 1_000);
      expect(persisted.filter((p) => p.name === 'victim')).toEqual([
        { name: 'victim', nextRun: repaired },
      ]);
      expect(warnings.filter((name) => name.startsWith('Timeout'))).toEqual([]);
    }
  );

  test('a cron whose next run cannot be recomputed is left out of the heap, not fired', async () => {
    const { scheduler: s, pushes, persisted } = harness();
    s.start();
    s.add({ name: 'healthy', queue: 'healthy-q', data: {}, repeatEvery: 40 });
    const hopeless = s.add({ name: 'hopeless', queue: 'hopeless-q', data: {}, repeatEvery: HOUR });
    // Neither a schedule nor an interval: validation never lets this in, so only an
    // in-place corruption can produce it.
    hopeless.repeatEvery = null;
    hopeless.nextRun = NaN;
    await Bun.sleep(300);

    expect(pushes.filter((q) => q === 'healthy-q').length).toBeGreaterThanOrEqual(3);
    expect(pushes).not.toContain('hopeless-q');
    expect(persisted.filter((p) => p.name === 'hopeless')).toEqual([]);
    expect(s.get('hopeless')).toBeDefined(); // still listed, so an operator can fix it
    expect(warnings.filter((name) => name.startsWith('Timeout'))).toEqual([]);
  });
});
