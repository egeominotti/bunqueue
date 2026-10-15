import { expect, test } from 'bun:test';
import { FrameParser } from '../src/infrastructure/server/protocol';
import { decodeMessagePack, encodeMessagePack } from '../src/shared/msgpack';
import { runCliRaw } from './cli-invariants/runtimeHarness';

for (const [family, subcommand, protocolCommand, verb] of [
  ['dlq', 'retry', 'RetryDlq', 'Retried'],
  ['queue', 'drain', 'Drain', 'Drained'],
] as const) {
  test(`CLI: ${family} family markers preserve legacy batch result labels`, async () => {
    const parser = new FrameParser();
    const received: Record<string, unknown>[] = [];
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket, data) {
          for (const frame of parser.addData(data)) {
            received.push(decodeMessagePack<Record<string, unknown>>(frame));
            socket.write(FrameParser.frame(encodeMessagePack({ ok: true, ids: ['legacy-a'] })));
          }
        },
      },
    });
    const queue = `marker-legacy-${process.pid}-${family}`;
    try {
      const result = await runCliRaw([
        '--host',
        '127.0.0.1',
        '--port',
        String(server.port),
        family,
        '--',
        subcommand,
        queue,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(received).toEqual([{ cmd: protocolCommand, queue }]);
      expect(result.stdout).toContain(`${verb} 1 jobs: legacy-a`);
    } finally {
      server.stop(true);
    }
  });
}
