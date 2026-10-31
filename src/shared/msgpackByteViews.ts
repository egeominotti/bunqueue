/**
 * Byte views for MessagePack encoding.
 *
 * msgpackr (without `moreTypes`) writes every ArrayBufferView as a `bin` of
 * `byteLength` bytes but copies it with `Uint8Array.prototype.set`, which converts
 * element by element: a Float32Array, Uint16Array, Float64Array, ... writes one
 * byte per element and leaves the rest of the `bin` as stale bytes of its shared
 * output buffer, a BigInt64Array throws, and a DataView becomes an empty `bin`.
 *
 * `packWithByteViews` writes each such view as a `bin` of exactly its own bytes,
 * so it arrives as a Uint8Array, and leaves every other value's bytes unchanged.
 *
 * Fast path: `ProbePackr` is msgpackr's default packer (`useRecords: false`, the
 * same module-level output buffer) whose `moreTypes` option is a getter that
 * returns false, as the default does, and records that it was read. msgpackr
 * reads `moreTypes` only for the values whose encoding depends on it: a TypedArray
 * that is not a Buffer, DataView, ArrayBuffer, Set, Error, RegExp and a BigInt
 * beyond 64 bits. A frame with none of them (plain objects, arrays, strings,
 * numbers, Dates, Buffers) is encoded in one pass with no extra work. After a
 * frame that did read it, a scan checks the value (allocation-free over plain
 * objects and arrays): with no
 * non-byte view (e.g. only the plain Uint8Arrays the broker decodes from `bin`)
 * the bytes already written are kept; otherwise `toByteViews` replaces each
 * non-byte view with a Uint8Array over its bytes (copy-on-write, no copy of the
 * data) and msgpackr's `pack` encodes the result. A module-load self-check
 * falls back to that rewrite for every frame if a future msgpackr stops
 * behaving as this assumes.
 *
 * `toByteViews` mirrors the order of msgpackr's type checks, so every rewritten
 * container encodes to the same bytes as the original apart from the views
 * themselves (one exception: in a rewritten object whose prototype chain makes
 * `hasOwnProperty` accept inherited keys, an inherited integer-like key moves
 * ahead of the own keys, since a plain object lists integer keys first). It only
 * descends into what msgpackr writes itself (objects whose
 * `constructor` is Object, whatever their prototype; null-prototype objects;
 * Array, Map, Set, Error), only rewrites built-in views, and rewrites each child
 * once, so its cost is linear. Everything else is opaque (left to msgpackr
 * unchanged): Date, RegExp, ArrayBuffer, class instances (with or without a
 * `toJSON`) and subclasses of those built-ins, which an app may encode with its own
 * `addExtension`. A built-in `Set`, `Error` or view type that an app has given its
 * own extension is opaque too, as far as an empty sample can tell: once per encode,
 * an empty sample of that type must read `moreTypes` and produce exactly the
 * built-in bytes (for a BigInt view, throw as the built-in path does). An app
 * extension that writes those same bytes for an empty value is not detected, and
 * without a probe (the fallback) the rewrite always applies. A view inside an
 * opaque value keeps msgpackr's previous encoding.
 *
 * A frame that takes the rewrite is encoded twice (probe, then `pack`), so a
 * `toJSON` or getter on an opaque value inside it runs twice.
 */

import { pack } from 'msgpackr';
import { mayContainNonByteView, toByteViews } from './msgpackByteViewRewrite';
import { moreTypesReadCount, probe } from './msgpackProbe';

/** msgpackr's default `pack`, except that a non-byte view is a `bin` of its own bytes. */
export function packWithByteViews(value: unknown): Uint8Array {
  if (probe === null) return pack(toByteViews(value));
  const before = moreTypesReadCount();
  let bytes: Uint8Array;
  try {
    bytes = probe.pack(value);
  } catch (error) {
    // A BigInt64Array makes msgpackr throw; any other failure repeats below unchanged.
    if (moreTypesReadCount() === before) throw error;
    return pack(toByteViews(value));
  }
  if (moreTypesReadCount() === before || !mayContainNonByteView(value)) return bytes;
  const rewritten = toByteViews(value);
  return rewritten === value ? bytes : pack(rewritten);
}
