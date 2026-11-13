/**
 * The test-only `timers` seam of getSharedManager() and the core E2E harness.
 * Without it the embedded runtime keeps the QueueManager defaults; with it a test
 * shortens the stall sweep or DLQ maintenance period of the manager it creates.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/application/types';
import { getSharedManager, peekSharedManager, shutdownManager } from '../src/client/manager';
import { CoreE2eHarness } from './core-e2e/support/harness';
import { brokerPeriods } from './docs-guide-support';

const dirs: string[] = [];
let harness: CoreE2eHarness | null = null;

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-shared-timers-'));
  dirs.push(dir);
  return join(dir, 'queue.db');
}

afterEach(async () => {
  await harness?.close();
  harness = null;
  shutdownManager();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('getSharedManager timers seam', () => {
  test('without timers the shared manager keeps the shipped periods', () => {
    shutdownManager();
    expect(DEFAULT_CONFIG.stallCheckMs).toBe(5_000);
    expect(DEFAULT_CONFIG.dlqMaintenanceMs).toBe(60_000);

    expect(brokerPeriods(getSharedManager(dbPath()))).toEqual({
      stallCheckMs: 5_000,
      dlqMaintenanceMs: 60_000,
    });
  });

  test('timers apply to the manager the call creates', () => {
    shutdownManager();
    const path = dbPath();
    const manager = getSharedManager(path, { stallCheckMs: 100 });

    expect(brokerPeriods(manager)).toEqual({ stallCheckMs: 100, dlqMaintenanceMs: 60_000 });
    // Later calls without timers reuse it, as every client does.
    expect(getSharedManager(path)).toBe(manager);
    expect(getSharedManager()).toBe(manager);
  });

  test('timers for an existing manager throw and leave it untouched', () => {
    shutdownManager();
    const path = dbPath();
    const manager = getSharedManager(path);

    expect(() => getSharedManager(path, { dlqMaintenanceMs: 100 })).toThrow(
      'Embedded QueueManager timers apply only when the manager is created'
    );
    expect(peekSharedManager()).toBe(manager);
    expect(brokerPeriods(manager).dlqMaintenanceMs).toBe(60_000);
  });

  test('invalid timers are refused by the QueueManager validation, creating nothing', () => {
    shutdownManager();

    expect(() => getSharedManager(dbPath(), { stallCheckMs: 0 })).toThrow(
      'QueueManager: stallCheckMs'
    );
    expect(peekSharedManager()).toBeNull();
  });
});

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`core E2E harness timers [${mode}]`, () => {
    test('the broker keeps the defaults when no timers are given', async () => {
      harness = await CoreE2eHarness.start(mode, 'timers-default');
      harness.queue('default');

      expect(brokerPeriods(harness.brokerManager())).toEqual({
        stallCheckMs: 5_000,
        dlqMaintenanceMs: 60_000,
      });
    });

    test('the broker runs on the given timers, also after a restart', async () => {
      const timers = { stallCheckMs: 100, dlqMaintenanceMs: 200 };
      harness = await CoreE2eHarness.start(mode, 'timers-fast', timers);
      const queue = harness.queue('fast');
      await queue.add('job', {});

      expect(brokerPeriods(harness.brokerManager())).toEqual(timers);
      await harness.restartBroker();
      expect(brokerPeriods(harness.brokerManager())).toEqual(timers);
    });
  });
}
