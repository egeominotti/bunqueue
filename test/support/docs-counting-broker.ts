/**
 * Shared broker fixture for test/docs-queue-guide/advanced-batching.test.ts and
 * advanced-forward.test.ts: a real TCP broker whose push entry points are
 * counted by a QueueManager subclass, plus the per-test cleanup.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllSharedPools, shutdownManager } from '../../src/client';
import { QueueManager } from '../../src/application/queueManager';
import type { Job, JobId, JobInput } from '../../src/domain/types/job';
import { createTcpServer, type TcpServer } from '../../src/infrastructure/server/tcp';

export class CountingQueueManager extends QueueManager {
  singlePushes = 0;
  batchPushes = 0;
  batchedJobs = 0;

  override async push(queue: string, input: JobInput): Promise<Job> {
    this.singlePushes++;
    return super.push(queue, input);
  }

  override async pushBatch(queue: string, inputs: JobInput[]): Promise<JobId[]> {
    this.batchPushes++;
    this.batchedJobs += inputs.length;
    return super.pushBatch(queue, inputs);
  }
}

export interface Broker {
  manager: CountingQueueManager;
  server: TcpServer;
  port: number;
  dataDir: string;
}

export const brokers: Broker[] = [];
const closers: Array<() => Promise<void> | void> = [];
const scratchDirs: string[] = [];

/** Embedded queues share one process-wide manager; give each test a fresh one. */
export function edgeDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bunqueue-docs-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

export function startBroker(label: string): Broker {
  const dataDir = mkdtempSync(join(tmpdir(), `bunqueue-docs-${label}-`));
  const manager = new CountingQueueManager({ dataPath: join(dataDir, 'queue.db') });
  const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  const broker: Broker = { manager, server, port: server.server.port, dataDir };
  brokers.push(broker);
  return broker;
}

export function track<T extends { close(): unknown }>(closeable: T): T {
  closers.push(() => {
    void closeable.close();
  });
  return closeable;
}

/** Run in afterEach: close tracked clients, the shared manager and pools, then the brokers. */
export async function cleanupBrokers(): Promise<void> {
  for (const close of closers.splice(0).reverse()) await close();
  shutdownManager();
  closeAllSharedPools();
  for (const broker of brokers.splice(0)) {
    broker.server.stop();
    broker.manager.shutdown();
    rmSync(broker.dataDir, { recursive: true, force: true });
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
