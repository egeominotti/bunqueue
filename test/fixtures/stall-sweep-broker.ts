/**
 * A TCP broker in its own process, for tests whose handler blocks the test
 * process's event loop: this broker's stall sweep keeps running meanwhile.
 *
 * argv[2]: SQLite path. argv[3]: stall sweep period in ms.
 * Prints `{"port":N}` on stdout once listening; exits when stdin closes, so an
 * aborted test run cannot leave it behind.
 */

import { QueueManager } from '../../src/application/queueManager';
import { createTcpServer } from '../../src/infrastructure/server/tcp';

const dataPath = process.argv[2];
const stallCheckMs = Number(process.argv[3]);
if (!dataPath || !Number.isFinite(stallCheckMs)) {
  throw new Error('usage: stall-sweep-broker.ts <dataPath> <stallCheckMs>');
}

const manager = new QueueManager({ dataPath, stallCheckMs });
const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
process.stdout.write(`${JSON.stringify({ port: server.server.port })}\n`);

let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  server.stop();
  manager.shutdown();
  process.exit(0);
}

process.on('SIGTERM', stop);
for await (const _chunk of Bun.stdin.stream()) {
  // drain: the parent never writes; the loop ends when its end of stdin closes
}
stop();
