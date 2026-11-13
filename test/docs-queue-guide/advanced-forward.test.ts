/**
 * Executable proof for the store-and-forward half of /guide/queue/advanced/
 * ("Namespaces, Auto-Batching and Store-and-Forward"); auto-batching is in
 * advanced-batching.test.ts.
 *
 * The central broker's push entry points are counted by a QueueManager
 * subclass, so "nothing reached the remote" is measured rather than assumed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../../src/client';
import { createTcpServer } from '../../src/infrastructure/server/tcp';
import { waitUntil } from '../docs-guide-support';
import {
  brokers,
  cleanupBrokers,
  CountingQueueManager,
  edgeDataDir,
  startBroker,
  track,
} from '../support/docs-counting-broker';

afterEach(async () => {
  await cleanupBrokers();
});

describe('queue guide · store-and-forward', () => {
  test('forward drains an embedded queue into a remote server', async () => {
    const central = startBroker('forward-central');
    const edgeDir = edgeDataDir('forward-edge');
    const edge = track(
      new Queue<{ reading: number }>(`edge-${crypto.randomUUID()}`, {
        embedded: true,
        dataPath: join(edgeDir, 'edge.db'),
      })
    );
    const remoteName = `central-${crypto.randomUUID()}`;
    const remote = track(
      new Queue(remoteName, {
        embedded: false,
        connection: { host: '127.0.0.1', port: central.port, poolSize: 1 },
        autoBatch: { enabled: false },
      })
    );

    const forwarded: Array<{ id: string; remoteId: string; name: string }> = [];
    const forwarder = edge.forward({
      to: { host: '127.0.0.1', port: central.port },
      queue: remoteName,
      concurrency: 4,
      durable: true,
    });
    forwarder.on('forwarded', (info) => forwarded.push(info));
    forwarder.on('error', () => undefined);

    try {
      const local = await edge.add('reading', { reading: 42 }, { durable: true });
      await waitUntil(
        async () => (await remote.countAsync()) === 1,
        'the job to reach the central broker',
        15_000
      );

      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].id).toBe(local.id);
      expect(forwarded[0].remoteId).toContain('fwd:');
      expect(forwarded[0].name).toBe('reading');

      const remoteJob = await remote.getJob(forwarded[0].remoteId);
      expect(remoteJob).not.toBeNull();
      expect((remoteJob?.data as { reading?: number }).reading).toBe(42);
    } finally {
      await forwarder.close();
    }
  }, 30_000);

  test('a re-forward of the same local job is deduped remotely', async () => {
    const central = startBroker('forward-dedupe');
    const remoteName = `central-${crypto.randomUUID()}`;
    const remote = track(
      new Queue(remoteName, {
        embedded: false,
        connection: { host: '127.0.0.1', port: central.port, poolSize: 1 },
        autoBatch: { enabled: false },
      })
    );

    const deterministicId = `fwd:edge-queue:${crypto.randomUUID()}`;
    await remote.add('reading', { reading: 1 }, { jobId: deterministicId, durable: true });
    await remote.add('reading', { reading: 1 }, { jobId: deterministicId, durable: true });

    expect(await remote.countAsync()).toBe(1);
  }, 20_000);

  test('a rejected remote push sends the local job to the local DLQ', async () => {
    // A token-protected central broker rejects the unauthenticated forward, the
    // documented "remote failure" path: local retry, then the local DLQ.
    const centralDir = mkdtempSync(join(tmpdir(), 'bunqueue-docs-forward-auth-'));
    const centralManager = new CountingQueueManager({ dataPath: join(centralDir, 'queue.db') });
    const centralServer = createTcpServer(centralManager, {
      hostname: '127.0.0.1',
      port: 0,
      authTokens: ['secret-token'],
    });
    brokers.push({
      manager: centralManager,
      server: centralServer,
      port: centralServer.server.port,
      dataDir: centralDir,
    });
    const edgeDir = edgeDataDir('forward-rejected');
    const edge = track(
      new Queue<{ reading: number }>(`edge-${crypto.randomUUID()}`, {
        embedded: true,
        dataPath: join(edgeDir, 'edge.db'),
      })
    );

    const forwarded: unknown[] = [];
    const forwarder = edge.forward({
      to: { host: '127.0.0.1', port: centralServer.server.port },
      concurrency: 1,
    });
    forwarder.on('error', () => undefined);
    forwarder.on('forwarded', (info) => forwarded.push(info));

    try {
      const local = await edge.add('reading', { reading: 7 }, { attempts: 1, durable: true });
      await waitUntil(
        async () => (await edge.getDlqAsync()).some((entry) => entry.job.id === local.id),
        'the rejected job to land in the local DLQ',
        20_000
      );

      expect(forwarded).toEqual([]);
      const entry = (await edge.getDlqAsync()).find((item) => item.job.id === local.id);
      expect(entry?.job.data).toMatchObject({ reading: 7 });
      expect(centralManager.singlePushes + centralManager.batchPushes).toBe(0);
    } finally {
      await forwarder.close();
    }
  }, 40_000);

  test('an unreachable remote never loses the local job', async () => {
    const edgeDir = edgeDataDir('forward-down');
    const edge = track(
      new Queue<{ reading: number }>(`edge-${crypto.randomUUID()}`, {
        embedded: true,
        dataPath: join(edgeDir, 'edge.db'),
      })
    );

    // Port 1 is not listening: the forward stays pending until the command timeout
    // (3 s, default 30 s: it outlasts the checks below, and close() waits for it).
    const remote = { host: '127.0.0.1', port: 1, commandTimeout: 3_000 };
    const forwarder = edge.forward({ to: remote, concurrency: 1 });
    forwarder.on('error', () => undefined);
    const delivered: unknown[] = [];
    forwarder.on('forwarded', (info) => delivered.push(info));

    try {
      const local = await edge.add('reading', { reading: 7 }, { attempts: 1, durable: true });
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(250);
        expect(['waiting', 'active', 'delayed', 'failed']).toContain(
          await edge.getJobState(local.id)
        );
      }
      expect(delivered).toEqual([]);
      expect((await edge.getJob(local.id))?.data).toMatchObject({ reading: 7 });
    } finally {
      await forwarder.close();
    }
  }, 40_000);
});
