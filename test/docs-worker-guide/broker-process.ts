/**
 * Starts test/fixtures/stall-sweep-broker.ts in a child process with a fresh
 * SQLite directory and a dynamic port, and tears both down.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BrokerProcess {
  readonly port: number;
  stop(): Promise<void>;
}

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'stall-sweep-broker.ts');

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`broker process exited before reporting its port: ${text}`);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.slice(0, text.indexOf('\n'));
}

export async function startBrokerProcess(stallCheckMs: number): Promise<BrokerProcess> {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-broker-process-'));
  const proc = Bun.spawn(
    [process.execPath, 'run', FIXTURE, join(dir, 'queue.db'), String(stallCheckMs)],
    {
      env: { ...process.env, BUNQUEUE_EMBEDDED: '', LOG_LEVEL: 'error' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    }
  );
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      proc.kill('SIGTERM');
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000)]);
      if (exited !== true) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
      rmSync(dir, { recursive: true, force: true });
    })();
    return stopped;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = await Promise.race([
      readFirstLine(proc.stdout),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('broker process did not report its port within 15 s')),
          15_000
        );
      }),
    ]);
    const { port } = JSON.parse(line) as { port: number };
    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
