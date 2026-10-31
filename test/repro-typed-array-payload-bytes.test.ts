/**
 * Repro: a non-byte TypedArray (Float32Array, Uint16Array, BigInt64Array, ...) in job
 * data reached workers over TCP, and SQLite after a restart, as a Uint8Array of the
 * wrong bytes. msgpackr writes a TypedArray without `moreTypes` as a msgpack `bin` of
 * `byteLength` bytes, but copies it with `target.set(typedArray)`, which converts each
 * element to one byte and leaves the rest of the bin as whatever the shared output
 * buffer held before (so the bytes even changed between runs); a BigInt64Array threw.
 * The intended, cross-SDK-portable encoding is a `bin` holding the array's own bytes:
 * the receiver gets a Uint8Array with exactly those bytes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { Queue } from '../src/client';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { decodeMessagePack, encodeMessagePack } from '../src/shared/msgpack';

const bytesOf = (view: ArrayBufferView) =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));

function sampleViews() {
  // Views with a byteOffset into a larger buffer, as subarray() returns them.
  const floats = new Float32Array([9, 0.5, 1.5, -2.25, 7]).subarray(1, 4);
  return {
    floats,
    words: new Uint16Array([1000, 2000, 65535]),
    doubles: new Float64Array([Math.PI, -0]),
    bigints: new BigInt64Array([1n, -2n, 9007199254740993n]),
    signed: new Int8Array([-1, 127, -128]),
  };
}

function expectSameBytes(received: Record<string, unknown>, sent: Record<string, ArrayBufferView>) {
  for (const [key, view] of Object.entries(sent)) {
    const value = received[key];
    expect(value).toBeInstanceOf(Uint8Array);
    expect(Array.from(value as Uint8Array)).toEqual(bytesOf(view));
  }
}

describe('typed arrays in payloads keep their bytes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test('encodeMessagePack writes each view as a bin of its own bytes, deterministically', () => {
    const sent = sampleViews();
    const first = encodeMessagePack({ data: sent });
    // Dirty the encoder's shared output buffer, then encode the same value again.
    encodeMessagePack({ noise: 'x'.repeat(4096), more: new Uint8Array(512).fill(0xab) });
    const second = encodeMessagePack({ data: sent });
    expect(Array.from(second)).toEqual(Array.from(first));
    expectSameBytes(decodeMessagePack<{ data: Record<string, unknown> }>(first).data, sent);
  });

  test('a job pushed over TCP reaches the broker and getJob with the same bytes', async () => {
    const qm = new QueueManager();
    const server: TcpServer = createTcpServer(qm, { hostname: '127.0.0.1', port: 0 });
    const queue = new Queue(`typed-tcp-${process.pid}`, {
      embedded: false,
      connection: { host: '127.0.0.1', port: server.server.port },
      autoBatch: { enabled: false },
    });
    cleanups.push(
      () => qm.shutdown(),
      () => server.stop(),
      () => queue.close()
    );

    const sent = sampleViews();
    const job = await queue.add('embed', sent);
    const fetched = await queue.getJob(job.id);
    expectSameBytes(fetched!.data as Record<string, unknown>, sent);
  });

  test('a durable job read back from SQLite after a restart has the same bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bunqueue-typed-array-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const dataPath = join(directory, 'queue.db');

    const sent = sampleViews();
    const writer = new QueueManager({ dataPath });
    const job = await writer.push('typed-sqlite', { data: sent, durable: true });
    writer.shutdown();

    const reader = new QueueManager({ dataPath });
    cleanups.push(() => reader.shutdown());
    const restored = await reader.getJob(job.id);
    expectSameBytes(restored!.data as Record<string, unknown>, sent);
  });
});
