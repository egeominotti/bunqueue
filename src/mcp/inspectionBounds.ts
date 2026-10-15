/** Output budgets for read-only agent inspection. Bounds apply to encoded JSON bytes. */
export const MAX_INSPECTION_BYTES = 65536;
export const MAX_VALUE_BYTES = 4096;
export const MAX_SUMMARY_ROWS = 50;

export function boundedPrompt(text: string) {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_INSPECTION_BYTES) return text;
  return `${bytes.subarray(0, MAX_INSPECTION_BYTES - 512).toString('utf8')}\n\n[truncated: prompt byte budget exceeded; use scoped queue resources and inspection tools. This snapshot cannot prove stalls, growth, starvation or absent consumers.]`;
}

/** JSON-safe bounded projection, without ever stringifying an unbounded input tree. */
export function boundedValue(value: unknown, maxBytes = MAX_VALUE_BYTES) {
  let truncated = false;
  let visited = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++visited > 100 || depth > 6) {
      truncated = true;
      return '[truncated]';
    }
    if (typeof input === 'string') {
      if (input.length > 256) truncated = true;
      return input.length > 256 ? `${input.slice(0, 256)}… [truncated]` : input;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (Array.isArray(input)) {
      if (input.length > 20) truncated = true;
      return input.slice(0, 20).map((item) => visit(item, depth + 1));
    }
    if (input && typeof input === 'object') {
      const result: Record<string, unknown> = {};
      let count = 0;
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (++count > 20) {
          truncated = true;
          break;
        }
        if (key.length > 256) {
          truncated = true;
          continue;
        }
        Object.defineProperty(result, key, {
          value: visit((input as Record<string, unknown>)[key], depth + 1),
          enumerable: true,
        });
      }
      return result;
    }
    return null;
  }
  let projected = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(projected)) > maxBytes) {
    projected = '[truncated: byte budget exceeded]';
    truncated = true;
  }
  return { value: projected, truncated };
}

/** Preserve broad resource arrays; append explicit metadata whenever rows are omitted. */
export function boundedRows<T>(
  rows: T[],
  project: (row: T) => unknown = (row) => row,
  total = rows.length
) {
  const result: unknown[] = [];
  let truncated = total > rows.length || rows.length > MAX_SUMMARY_ROWS;
  for (const row of rows.slice(0, MAX_SUMMARY_ROWS)) {
    const item = boundedValue(project(row));
    truncated ||= item.truncated;
    if (Buffer.byteLength(JSON.stringify([...result, item.value])) > MAX_INSPECTION_BYTES - 1024) {
      truncated = true;
      break;
    }
    result.push(item.value);
  }
  if (truncated) result.push({ truncated: true, total, shown: result.length });
  return result;
}
