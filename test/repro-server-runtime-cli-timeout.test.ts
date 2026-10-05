/**
 * Repro: the CLI armed its per-command timer with `max(30000, --timeout + 10000)` through
 * a native setTimeout. A long-poll `--timeout` above about 2.1e9 ms overflowed the timer,
 * so the CLI printed "Command timeout" after about 1 ms instead of the server's answer
 * (the server rejects such a timeout with a range error).
 *
 * A fake server answers each command after 150 ms, so the only way to see "Command
 * timeout" is the overflowed client timer.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Socket, TCPSocketListener } from 'bun';
import { FrameParser } from '../src/infrastructure/server/protocol';
import { decodeMessagePack, encodeMessagePack } from '../src/shared/msgpack';
import { spawnChild } from './server-runtime-support';

setDefaultTimeout(60_000);

const REPLY_DELAY_MS = 150;
const SERVER_ERROR = 'timeout must be at most 60000';

let listener: TCPSocketListener<{ parser: FrameParser }> | null = null;
const received: Array<Record<string, unknown>> = [];

beforeAll(() => {
  listener = Bun.listen<{ parser: FrameParser }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket: Socket<{ parser: FrameParser }>) {
        socket.data = { parser: new FrameParser() };
      },
      data(socket, data) {
        for (const frame of socket.data.parser.addData(new Uint8Array(data))) {
          const command = decodeMessagePack<Record<string, unknown>>(frame);
          received.push(command);
          setTimeout(() => {
            socket.write(FrameParser.frame(encodeMessagePack({ ok: false, error: SERVER_ERROR })));
          }, REPLY_DELAY_MS);
        }
      },
    },
  });
});

afterAll(() => {
  listener?.stop(true);
});

function runCli(args: string[]) {
  return spawnChild(
    [
      process.execPath,
      'src/main.ts',
      ...args,
      '--host',
      '127.0.0.1',
      '--port',
      String(listener!.port),
      '--json',
    ],
    {}
  );
}

describe('CLI client command timeout', () => {
  test('a long-poll --timeout above the timer limit waits for the server answer', async () => {
    const [pull, wait] = await Promise.all([
      runCli(['pull', 'runtime-cli', '--timeout', '3000000000']),
      runCli(['job', 'wait', '42', '--timeout', '3000000000']),
    ]);
    for (const result of [pull, wait]) {
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain('Command timeout');
      expect(result.output).toContain(SERVER_ERROR);
    }
    expect(received.map((command) => [command.cmd, command.timeout])).toEqual(
      expect.arrayContaining([
        ['PULL', 3_000_000_000],
        ['WaitJob', 3_000_000_000],
      ])
    );
  });
});
