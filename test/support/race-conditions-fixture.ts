import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../../src/application/queueManager';

/** Each test owns its SQLite files, even when different race suites run in parallel. */
export function raceConditionsFixture(options: ConstructorParameters<typeof QueueManager>[0] = {}) {
  let directory: string | undefined;
  let manager: QueueManager | undefined;
  return {
    async create() {
      directory = await mkdtemp(join(tmpdir(), 'bunqueue-race-'));
      manager = new QueueManager({ ...options, dataPath: join(directory, 'queue.db') });
      return manager;
    },
    async close() {
      try {
        manager?.shutdown();
      } finally {
        manager = undefined;
        if (directory) await rm(directory, { recursive: true, force: true });
        directory = undefined;
      }
    },
  };
}
