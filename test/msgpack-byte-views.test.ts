/**
 * `encodeMessagePack` rewrites non-byte views only inside exact built-ins (plain and
 * null-prototype objects, Array, Map, Set, Error). Class instances, subclasses of
 * those built-ins and values with a `toJSON` stay opaque, so msgpackr, including an
 * app's own `addExtension`, encodes them exactly as `pack` does.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { addExtension, pack, Packr } from 'msgpackr';
import { decodeMessagePack, encodeMessagePack } from '../src/shared/msgpack';
import { toByteViews } from '../src/shared/msgpackByteViewRewrite';

const bytesOf = (view: ArrayBufferView) =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
const same = (value: unknown) =>
  expect(Array.from(encodeMessagePack(value))).toEqual(Array.from(pack(value)));

class Embedding {
  constructor(readonly vector: Float32Array) {}
}
addExtension({
  Class: Embedding,
  type: 0x51,
  pack: (instance: Embedding) =>
    Buffer.from(instance.vector.buffer, instance.vector.byteOffset, instance.vector.byteLength),
  unpack: (bytes: Uint8Array) => new Embedding(new Float32Array(new Uint8Array(bytes).buffer)),
});

describe('msgpack byte views stay out of opaque values', () => {
  test('an addExtension class keeps its extension next to a rewritten view', () => {
    const value = {
      tags: new Set(['a']),
      emb: new Embedding(new Float32Array([1, 2])),
      raw: new Uint16Array([7]),
    };
    const decoded = decodeMessagePack<{ emb: Embedding; raw: Uint8Array }>(
      encodeMessagePack(value)
    );
    expect(decoded.emb).toBeInstanceOf(Embedding);
    expect(Array.from(decoded.emb.vector)).toEqual([1, 2]);
    expect(Array.from(decoded.raw)).toEqual(bytesOf(new Uint16Array([7])));
  });

  test('class instances, subclasses and toJSON values encode exactly like pack', () => {
    class Holder {
      constructor(readonly v: number[]) {}
    }
    class Tagged extends Array<number> {}
    class Reasons extends Map<string, number> {}
    same({ tags: new Set([1]), holder: new Holder([1, 2]) });
    same({ tags: new Set([1]), list: Tagged.from([1, 2]), reasons: new Reasons([['x', 1]]) });
    same({ tags: new Set([1]), when: { toJSON: () => 'json-form' } });
    same({ tags: new Set([1]), err: new TypeError('boom') });
  });

  test('views in built-in containers are written as their own bytes', () => {
    const floats = new Float32Array([0.5, 1.5, -2.25, 9]).subarray(1, 3);
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { f: floats });
    const value = {
      list: [floats],
      map: new Map([['k', floats]]),
      set: new Set([floats]),
      err: Object.assign(new Error('e', { cause: floats })),
      nullProto,
      view: new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2),
    };
    const decoded = decodeMessagePack<Record<string, unknown>>(encodeMessagePack(value));
    const expected = bytesOf(floats);
    expect(Array.from((decoded.list as Uint8Array[])[0])).toEqual(expected);
    expect(Array.from((decoded.map as Record<string, Uint8Array>).k)).toEqual(expected);
    expect(Array.from((decoded.set as Uint8Array[])[0])).toEqual(expected);
    expect(Array.from((decoded.nullProto as Record<string, Uint8Array>).f)).toEqual(expected);
    expect(Array.from(decoded.view as Uint8Array)).toEqual([2, 3]);
  });

  test('a plain object with its own constructor key still gets its views fixed', () => {
    const floats = new Float32Array([1.5]);
    const decoded = decodeMessagePack<{ v: Uint8Array }>(
      encodeMessagePack({ constructor: 'x', tags: new Set([1]), v: floats })
    );
    expect(Array.from(decoded.v)).toEqual(bytesOf(floats));
  });

  test('an object made with Object.create gets its views fixed like a plain one', () => {
    const floats = new Float32Array([1.5, 2.5]);
    const defaults = { inherited: 1 };
    const nested = Object.assign(Object.create(defaults) as Record<string, unknown>, { v: floats });
    const top = Object.assign(Object.create(defaults) as Record<string, unknown>, { v: floats });
    const decoded = decodeMessagePack<{ n: { v: Uint8Array } }>(encodeMessagePack({ n: nested }));
    expect(Array.from(decoded.n.v)).toEqual(bytesOf(floats));
    expect(Array.from(decodeMessagePack<{ v: Uint8Array }>(encodeMessagePack(top)).v)).toEqual(
      bytesOf(floats)
    );
    same({ tags: new Set([1]), n: Object.assign(Object.create(defaults), { a: [1, 'x'] }) });
  });

  test('the rewrite path writes the same bytes as the fast path', () => {
    const floats = new Float32Array([0.5, -2.25, 9]).subarray(1);
    const frames: unknown[] = [
      { a: 1, s: 'x', d: new Date(0), b: Buffer.from([1, 2]) },
      { list: [floats], map: new Map([['k', floats]]), set: new Set([floats, 1]) },
      { err: new Error('e', { cause: floats }), view: new DataView(new ArrayBuffer(4), 1, 2) },
      { big: new BigInt64Array([1n, -2n]), raw: new Uint8Array([3]), re: /x/g },
      [new Uint16Array([7]), { deep: [{ v: new Float64Array([1]) }] }],
    ];
    for (const frame of frames) {
      expect(Array.from(encodeMessagePack(frame))).toEqual(Array.from(pack(toByteViews(frame))));
    }
  });
});

describe('msgpack byte views stay linear and respect built-in extensions', () => {
  test('deeply nested Sets and Maps from a client frame re-encode in linear time', () => {
    // What a client can send: ext Sets/Maps around a typed array, decoded by the broker.
    const client = new Packr({ moreTypes: true, useRecords: false });
    let sets: unknown = new Float32Array([1, 2]);
    let maps: unknown = new Float32Array([3, 4]);
    for (let depth = 0; depth < 28; depth++) {
      sets = new Set([sets, depth]);
      maps = new Map<unknown, unknown>([
        ['k', maps],
        ['d', depth],
      ]);
    }
    const decoded = decodeMessagePack<unknown>(client.pack({ sets, maps }));
    const started = performance.now();
    encodeMessagePack(decoded);
    expect(performance.now() - started).toBeLessThan(500);
  });

  // addExtension is process-wide, so each case runs in its own process and reports
  // whether encodeMessagePack wrote every frame exactly as msgpackr's pack does.
  const shared = JSON.stringify(join(import.meta.dir, '..', 'src', 'shared', 'msgpack.ts'));
  async function sameAsPackWith(extension: string, frames: string): Promise<string> {
    const script = `
      import { addExtension, pack } from 'msgpackr';
      import { encodeMessagePack } from ${shared};
      addExtension(${extension});
      const frames = ${frames};
      const same = frames.every((f) => Buffer.from(encodeMessagePack(f)).equals(Buffer.from(pack(f))));
      console.log(same ? 'same' : 'different');
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return out.trim() || err.trim();
  }

  test('an app extension registered on a built-in type keeps encoding it', async () => {
    expect(
      await sameAsPackWith(
        `{ Class: Float32Array, type: 0x52, pack: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength), unpack: (b) => new Float32Array(new Uint8Array(b).buffer) }`,
        `[{ v: new Float32Array([1, 2]) }, { v: new Float32Array([1, 2]), tags: new Set([1]) }, { e: new Error('x'), v: new Float32Array([3]) }]`
      )
    ).toBe('same');
  });

  // With a non-byte view next to it (the trigger, which is rewritten), the field the
  // app extension owns must still come back through that extension.
  async function decodedWith(extension: string, frame: string, field: string): Promise<string> {
    const script = `
      import { addExtension, unpack } from 'msgpackr';
      import { encodeMessagePack } from ${shared};
      addExtension(${extension});
      const decoded = unpack(encodeMessagePack(${frame}));
      console.log(JSON.stringify([decoded.${field}?.constructor?.name, Array.from(decoded.trigger)]));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return out.trim() || err.trim();
  }
  const triggerBytes = Array.from(new Uint8Array(new Uint16Array([7]).buffer));

  test('an app extension that throws on an empty value still wins', async () => {
    const result = await decodedWith(
      `{ Class: Float32Array, type: 0x53, pack: (v) => { if (v.length === 0) throw new Error('empty'); return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }, unpack: (b) => new Float32Array(new Uint8Array(b).buffer) }`,
      `{ a: new Float32Array([1.5, 2.5]), trigger: new Uint16Array([7]) }`,
      'a'
    );
    expect(JSON.parse(result)).toEqual(['Float32Array', triggerBytes]);
  });

  test('an app extension whose output contains a view still wins', async () => {
    const result = await decodedWith(
      `{ Class: Set, type: 0x54, write: (s) => ({ hdr: new Uint8Array([s.size]), items: [...s] }), read: (v) => new Set(v.items) }`,
      `{ s: new Set([1, new Float32Array([1.5])]), trigger: new Uint16Array([7]) }`,
      's'
    );
    expect(JSON.parse(result)).toEqual(['Set', triggerBytes]);
  });

  test('without a probe (the fallback) every frame takes the rewrite', async () => {
    // mock.module is process-wide too, so the probe is switched off in a child process.
    const probe = JSON.stringify(join(import.meta.dir, '..', 'src', 'shared', 'msgpackProbe.ts'));
    const script = `
      import { mock } from 'bun:test';
      mock.module(${probe}, () => ({ probe: null, moreTypesReadCount: () => 0 }));
      const { encodeMessagePack } = await import(${shared});
      const { probe } = await import(${probe});
      const { pack, unpack } = await import('msgpackr');
      const plain = { a: 1, s: 'x', d: new Date(0), b: Buffer.from([1, 2]), t: new Set([1]) };
      const views = { f: new Float32Array([1.5]), big: new BigInt64Array([-2n]) };
      const decoded = unpack(encodeMessagePack(views));
      console.log(JSON.stringify([
        probe,
        Buffer.from(encodeMessagePack(plain)).equals(Buffer.from(pack(plain))),
        Array.from(decoded.f),
        Array.from(decoded.big),
      ]));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    expect(JSON.parse(out.trim() || JSON.stringify(err.trim()))).toEqual([
      null,
      true,
      bytesOf(new Float32Array([1.5])),
      bytesOf(new BigInt64Array([-2n])),
    ]);
  });
});
