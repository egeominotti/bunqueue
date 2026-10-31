import { expect, test } from 'bun:test';
import { unpack } from 'msgpackr';
import { serializeCommand } from '../src/serialization.js';

// A non-byte TypedArray or DataView travels as a msgpack `bin` of exactly its own
// bytes (as the broker writes it), instead of being refused with SerializationError.
const bytesOf = (view: ArrayBufferView) =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));

function decodeFrame(frame: Buffer): Record<string, unknown> {
  const length = frame.readUInt32BE(0);
  return unpack(frame.subarray(4, 4 + length)) as Record<string, unknown>;
}

test('non-byte views are sent as a bin of their own bytes', () => {
  const floats = new Float32Array([9, 0.5, 1.5, -2.25]).subarray(1, 3);
  const data = {
    floats,
    words: new Uint16Array([1000, 65535]),
    bigints: new BigInt64Array([1n, -2n]),
    view: new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2),
    clamped: new Uint8ClampedArray([0, 255]),
  };
  const first = serializeCommand({ cmd: 'PUSH', queue: 'q', name: 'j', data }, 'r1');
  serializeCommand({ cmd: 'PUSH', queue: 'q', name: 'noise', data: { s: 'x'.repeat(4096) } }, 'r2');
  const second = serializeCommand({ cmd: 'PUSH', queue: 'q', name: 'j', data }, 'r1');
  expect(Array.from(second)).toEqual(Array.from(first));

  const sent = decodeFrame(first).data as Record<string, Uint8Array>;
  for (const [key, view] of Object.entries(data)) {
    expect(sent[key]).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent[key])).toEqual(bytesOf(view));
  }
});
