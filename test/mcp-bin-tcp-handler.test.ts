/**
 * The real `bunqueue-mcp` bin in TCP mode: an HTTP handler registered through MCP must
 * process jobs on the remote broker, and the MCP process must never open a local
 * embedded database for it (even when DATA_PATH is set in its environment).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { QueueManager } from '../src/application/queueManager';
import { jobId as toJobId } from '../src/domain/types/job';
import { createTcpServer } from '../src/infrastructure/server/tcp';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** The parent environment without any bunqueue setting, plus `extra`. */
function binEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(BUNQUEUE_|BQ_|DATA_PATH$|SQLITE_PATH$)/.test(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function text(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('bunqueue-mcp bin in TCP mode', () => {
  test('an HTTP handler processes jobs on the broker without a local database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-mcp-bin-tcp-'));
    const qm = new QueueManager({ dataPath: join(dir, 'broker.db') });
    const tcp = createTcpServer(qm, { port: 0, hostname: '127.0.0.1' });
    cleanups.push(() => {
      tcp.stop();
      qm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });

    let hits = 0;
    const endpoint = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        hits++;
        return Response.json({ ok: true });
      },
    });
    cleanups.push(() => endpoint.stop(true));

    const localDb = join(dir, 'must-not-exist.db');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['src/mcp/index.ts'],
      cwd: join(import.meta.dir, '..'),
      env: binEnv({
        BUNQUEUE_MODE: 'tcp',
        BUNQUEUE_HOST: '127.0.0.1',
        BUNQUEUE_PORT: String(tcp.server.port),
        DATA_PATH: localDb,
      }),
      stderr: 'ignore',
    });
    const client = new Client({ name: 'bin-test', version: '1.0.0' });
    await client.connect(transport);
    cleanups.push(() => client.close());

    await client.callTool({
      name: 'bunqueue_register_handler',
      arguments: { queue: 'hooks', url: `http://127.0.0.1:${endpoint.port}/x`, method: 'POST' },
    });
    const added = text(
      await client.callTool({
        name: 'bunqueue_add_job',
        arguments: { queue: 'hooks', name: 'n', data: { v: 1 } },
      })
    );
    const jobId = String(added.jobId);

    let state = '';
    for (let i = 0; i < 100 && state !== 'completed'; i++) {
      await Bun.sleep(100);
      state = String(await qm.getJobState(toJobId(jobId)));
    }
    expect(state).toBe('completed');
    expect(hits).toBe(1);
    expect(existsSync(localDb)).toBe(false);
  }, 30_000);
});
