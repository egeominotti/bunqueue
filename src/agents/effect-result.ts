/** Reject lossy JSON values so a completed replay has the same result as the first invocation. */
export function encodeEffectResult(value: unknown): string {
  const seen = new Set<object>();
  function visit(current: unknown, top = false): void {
    if (current === undefined && top) return;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || current === null)
      throw new Error('Agent effect result must be JSON-compatible');
    if (seen.has(current)) throw new Error('Agent effect result contains a cycle');
    const array = Array.isArray(current);
    if (array && Object.getPrototypeOf(current) !== Array.prototype) {
      throw new Error('Agent effect result must contain only plain arrays');
    }
    if (
      !Array.isArray(current) &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    ) {
      throw new Error('Agent effect result must contain only plain JSON objects');
    }
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Agent effect result contains a symbol');
      if (Array.isArray(current) && key === 'length') continue;
      if (array) {
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= current.length ||
          String(index) !== key
        ) {
          throw new Error('Agent effect array contains a non-index property');
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) throw new Error('Agent effect result changed during serialization');
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new Error('Agent effect result contains non-JSON properties');
      visit(descriptor.value);
    }
    if (array && keys.length !== current.length + 1) {
      throw new Error('Agent effect result contains a sparse or extended array');
    }
    seen.delete(current);
  }
  visit(value, true);
  return JSON.stringify({ value });
}
