/**
 * The copy-on-write rewrite behind `packWithByteViews` (see msgpackByteViews.ts):
 * every built-in non-byte view inside the containers msgpackr writes itself becomes a
 * Uint8Array over its bytes; everything else is returned unchanged. Each child is
 * rewritten once, so the cost stays linear in the size of the value.
 */

import { moreTypesReadCount, probe } from './msgpackProbe';

type PlainRecord = Record<PropertyKey, unknown>;

const isByteView = (view: ArrayBufferView): boolean =>
  (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1;

const byteView = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** Built-in non-byte views; a subclass stays opaque (it may carry its own extension). */
const builtInViews = new Set<unknown>(
  [
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
    (globalThis as { Float16Array?: unknown }).Float16Array,
  ].filter(Boolean)
);

/**
 * The test msgpackr's default object writer applies to each for-in key: the
 * object's own `hasOwnProperty` (even an overridden one), or every key without one.
 */
function isWritten(object: PlainRecord, key: string): boolean {
  const hasOwn = object.hasOwnProperty;
  return typeof hasOwn !== 'function' || Boolean(hasOwn.call(object, key));
}

function setKey(target: PlainRecord, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    target[key] = value;
  }
}

function rewriteObject(object: PlainRecord): unknown {
  let copy: PlainRecord | undefined;
  for (const key in object) {
    if (!isWritten(object, key)) continue;
    const item = object[key];
    const next = typeof item === 'object' && item !== null ? rewrite(item) : item;
    if (copy !== undefined) {
      setKey(copy, key, next);
    } else if (next !== item) {
      // A plain object encodes exactly like a class instance with the same written keys.
      copy = {};
      for (const prior in object) {
        if (prior === key) break;
        if (isWritten(object, prior)) setKey(copy, prior, object[prior]);
      }
      setKey(copy, key, next);
    }
  }
  return copy ?? object;
}

function rewriteArray(array: readonly unknown[]): unknown {
  let copy: unknown[] | undefined;
  for (let index = 0, length = array.length; index < length; index++) {
    const item = array[index];
    const next = typeof item === 'object' && item !== null ? rewrite(item) : item;
    if (copy !== undefined) copy[index] = next;
    else if (next !== item) {
      // A plain array encodes exactly like an Array subclass instance or a hole-y array.
      copy = new Array<unknown>(length);
      for (let prior = 0; prior < index; prior++) copy[prior] = array[prior];
      copy[index] = next;
    }
  }
  return copy ?? array;
}

/** One pass: each key and value is rewritten once, so nested Maps stay linear. */
function rewriteMap(map: Map<unknown, unknown>): unknown {
  const entries: Array<[unknown, unknown]> = [];
  let changed = false;
  for (const [key, item] of map) {
    const nextKey = rewrite(key);
    const nextItem = rewrite(item);
    if (nextKey !== key || nextItem !== item) changed = true;
    entries.push([nextKey, nextItem]);
  }
  return changed ? new Map(entries) : map;
}

/**
 * msgpackr writes a Set as `Array.from(set)`, so the rewritten array encodes the same.
 * One pass over the items, so nested Sets stay linear.
 */
function rewriteSet(set: Set<unknown>): unknown {
  const items = Array.from(set);
  const next = rewriteArray(items);
  return next === items ? set : next;
}

/** msgpackr writes an Error as `[name, message, cause]`, so that array encodes the same. */
function rewriteError(error: Error): unknown {
  const { name, message, cause } = error;
  const nextName = rewrite(name);
  const nextMessage = rewrite(message);
  const nextCause = rewrite(cause);
  if (nextName === name && nextMessage === message && nextCause === cause) return error;
  return [nextName, nextMessage, nextCause];
}

/**
 * Per encode: whether msgpackr still encodes a built-in type itself. An app's own
 * `addExtension` for `Set`, `Error` or a TypedArray is checked before the built-in
 * one, and only the built-in one reads `moreTypes`, so an empty sample that does not
 * read it means the app encodes that type and the value must stay opaque.
 */
let nativeTypes: Map<unknown, boolean> | null = null;

/**
 * What msgpackr's built-in extension writes for each empty sample: an app extension
 * writes an ext prefix instead (and the built-in one for a BigInt view throws), so a
 * sample is native only if it read `moreTypes` and produced exactly these bytes.
 */
const NATIVE_SET = Uint8Array.of(0x90);
const NATIVE_VIEW = Uint8Array.of(0xc4, 0x00);
const NATIVE_ERROR = Uint8Array.of(
  0x93,
  0xa5,
  0x45,
  0x72,
  0x72,
  0x6f,
  0x72,
  0xa0,
  0xd4,
  0x00,
  0x00
);
const THROWS = null;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function encodedNatively(
  constructor: unknown,
  sample: () => object,
  expected: Uint8Array | typeof THROWS
): boolean {
  if (probe === null) return true; // no probe to ask: the rewrite always applies
  const cache = (nativeTypes ??= new Map());
  let native = cache.get(constructor);
  if (native === undefined) {
    const before = moreTypesReadCount();
    let bytes: Uint8Array | null = null;
    try {
      bytes = probe.pack(sample());
    } catch {
      bytes = null;
    }
    const read = moreTypesReadCount() !== before;
    native =
      read &&
      (bytes === null ? expected === THROWS : expected !== THROWS && sameBytes(bytes, expected));
    cache.set(constructor, native);
  }
  return native;
}

function rewrite(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const constructor = (value as { constructor?: unknown }).constructor;
  // msgpackr writes anything whose `constructor` is Object as a map before it looks
  // at extensions or toJSON, whatever its prototype (e.g. `Object.create(defaults)`).
  if (constructor === Object) return rewriteObject(value as PlainRecord);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype === Object.prototype || prototype === null) {
    // msgpackr writes these as maps whatever their own `constructor` key says, except
    // that one not equal to Object sends a function-valued `toJSON` through toJSON.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    return typeof toJSON !== 'function' ? rewriteObject(value as PlainRecord) : value;
  }
  if (prototype === Array.prototype) return rewriteArray(value as unknown[]);
  if (constructor === Map) return rewriteMap(value as Map<unknown, unknown>);
  if (constructor === Set) {
    return encodedNatively(Set, () => new Set(), NATIVE_SET)
      ? rewriteSet(value as Set<unknown>)
      : value;
  }
  if (constructor === Error) {
    return encodedNatively(Error, () => new Error(''), NATIVE_ERROR)
      ? rewriteError(value as Error)
      : value;
  }
  if (ArrayBuffer.isView(value)) {
    if (isByteView(value) || !builtInViews.has(constructor)) return value;
    const sample = () =>
      constructor === DataView
        ? new DataView(new ArrayBuffer(0))
        : new (constructor as new (length: number) => object)(0);
    // msgpackr's built-in path throws on a BigInt view even when it is empty.
    const bigInt = constructor === BigInt64Array || constructor === BigUint64Array;
    return encodedNatively(constructor, sample, bigInt ? THROWS : NATIVE_VIEW)
      ? byteView(value)
      : value;
  }
  // Date, RegExp, ArrayBuffer, class instances and subclasses of the built-ins above:
  // msgpackr (or an app's addExtension) encodes these.
  return value;
}

/**
 * Return `value` with every non-byte ArrayBufferView replaced by a Uint8Array of its
 * bytes. If the walk itself throws (a circular value overflowing the stack, a
 * throwing getter), the original value is returned so msgpackr reports the failure
 * exactly as it did before.
 */
export function toByteViews(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const outer = nativeTypes;
  nativeTypes = null;
  try {
    return rewrite(value);
  } catch {
    return value;
  } finally {
    nativeTypes = outer;
  }
}

/**
 * Whether `toByteViews` would change `value`, without allocating. Plain objects
 * and arrays (the bulk of a frame) are scanned inline, over every for-in key, a
 * superset of the keys msgpackr writes; anything else defers to `rewrite`. A
 * false positive only costs a `toByteViews` that returns the value unchanged.
 */
function containsNonByteView(value: object): boolean {
  const constructor = (value as { constructor?: unknown }).constructor;
  if (constructor === Object) {
    for (const key in value) {
      const item = (value as PlainRecord)[key];
      if (typeof item === 'object' && item !== null && containsNonByteView(item)) return true;
    }
    return false;
  }
  if (constructor === Array) {
    const array = value as unknown[];
    for (let index = 0, length = array.length; index < length; index++) {
      const item = array[index];
      if (typeof item === 'object' && item !== null && containsNonByteView(item)) return true;
    }
    return false;
  }
  if (ArrayBuffer.isView(value)) return !isByteView(value);
  return rewrite(value) !== value;
}

/** `containsNonByteView`, treating a scan failure (stack overflow, throwing getter) as a hit. */
export function mayContainNonByteView(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const outer = nativeTypes;
  nativeTypes = null;
  try {
    return containsNonByteView(value);
  } catch {
    return true;
  } finally {
    nativeTypes = outer;
  }
}
