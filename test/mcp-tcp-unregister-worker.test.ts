/**
 * MCP TCP adapter: `unregister_worker` (TcpServiceBackend.unregisterWorker).
 *
 * The broker reads the worker to remove from `workerId` (UnregisterWorkerCommand); a
 * command that names it `id` removes nothing and is answered "Worker not found", so the
 * tool would report `success: false` for a worker that exists and leave it registered.
 * Driven against a real in-process TCP broker on a dynamic port, and checked on the wire
 * by recording every command the adapter's connection pool sends.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { TcpBackend } from '../src/mcp/adapter';

let manager: QueueManager;
let server: TcpServer;
let backend: TcpBackend;
const sent: Record<string, unknown>[] = [];

beforeAll(async () => {
  manager = new QueueManager();
  server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  backend = new TcpBackend({ host: '127.0.0.1', port: server.server.port });
  // Record the commands on their way to the real pool; replies are untouched.
  const pool = (backend as unknown as { pool: { send(command: Record<string, unknown>): unknown } })
    .pool;
  const send = pool.send.bind(pool);
  pool.send = (command) => {
    sent.push(command);
    return send(command);
  };
  await backend.connect();
});

afterAll(async () => {
  backend.shutdown();
  server.stop();
  await manager.shutdown();
});

function unregisterCommands(): Record<string, unknown>[] {
  return sent.filter((command) => command.cmd === 'UnregisterWorker');
}

describe('MCP TCP adapter unregisterWorker', () => {
  test('sends the worker id as workerId and removes the worker', async () => {
    const queue = `mcp-unregister-${crypto.randomUUID()}`;
    const worker = await backend.registerWorker('mcp-unregister-worker', [queue]);
    expect((await backend.listWorkers()).map((listed) => listed.id)).toContain(worker.id);

    sent.length = 0;
    expect(await backend.unregisterWorker(worker.id)).toBe(true);

    expect(unregisterCommands()).toHaveLength(1);
    const command = unregisterCommands()[0]!;
    expect(command.workerId).toBe(worker.id);
    expect(command).not.toHaveProperty('id');
    expect((await backend.listWorkers()).map((listed) => listed.id)).not.toContain(worker.id);
  });

  test('a second unregister of the same worker reports false, not an error', async () => {
    const worker = await backend.registerWorker('mcp-unregister-twice', ['mcp-unregister-q']);
    expect(await backend.unregisterWorker(worker.id)).toBe(true);
    expect(await backend.unregisterWorker(worker.id)).toBe(false);
  });

  test('unregistering one worker leaves the others registered', async () => {
    const kept = await backend.registerWorker('mcp-unregister-kept', ['mcp-unregister-q']);
    const removed = await backend.registerWorker('mcp-unregister-removed', ['mcp-unregister-q']);
    expect(await backend.unregisterWorker(removed.id)).toBe(true);
    const ids = (await backend.listWorkers()).map((listed) => listed.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(removed.id);
  });
});
