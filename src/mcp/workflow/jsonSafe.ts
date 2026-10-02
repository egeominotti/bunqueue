/**
 * Turn a value decoded from the workflow store into plain JSON.
 *
 * The store's msgpack codec runs with `structuredClone: true`, so inputs, step results
 * and signal payloads can hold BigInt, Date, Map, Set, typed arrays, Error objects,
 * undefined values and even cycles. JSON.stringify throws on BigInt and cycles and
 * silently mangles the rest (a Map becomes `{}`), so every value is converted
 * explicitly before it leaves the MCP server.
 */

function bytes(view: ArrayBufferView | ArrayBuffer): Record<string, unknown> {
  const u8 = ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view);
  return { $type: 'bytes', byteLength: u8.byteLength, base64: Buffer.from(u8).toString('base64') };
}

function convertObject(value: object, path: Set<object>): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return bytes(value);
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return { $type: 'Error', name: value.name, message: value.message };
  if (path.has(value)) return '[Circular]';
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => convert(item, path) ?? null);
    if (value instanceof Map) {
      return {
        $type: 'Map',
        entries: [...value].map(([k, v]) => [convert(k, path) ?? null, convert(v, path) ?? null]),
      };
    }
    if (value instanceof Set) {
      return { $type: 'Set', values: [...value].map((item) => convert(item, path) ?? null) };
    }
    // Object.fromEntries defines own properties, so a "__proto__" key stays a key.
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, convert(item, path)] as const)
        .filter(([, item]) => item !== undefined)
    );
  } finally {
    path.delete(value);
  }
}

function convert(value: unknown, path: Set<object>): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return undefined;
    case 'symbol':
    case 'function':
      return String(value);
    default:
      return value === null ? null : convertObject(value as object, path);
  }
}

/** A JSON-serializable copy of `value`. Undefined object properties are dropped. */
export function toJsonSafe(value: unknown): unknown {
  return convert(value, new Set());
}

/** Epoch milliseconds as an ISO string; null when absent or out of range. */
export function isoTime(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}
