/** Runtime primitives only: job and scheduling logic stays in the canonical client. */
import { access, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { safeTimeout } from '../../../../src/shared/timers.js';
export { ThreadWorker } from './thread-worker.js';

export const hardwareConcurrency = (() => {
  try {
    // The embedded engine sizes shards from this exact runtime value. Host
    // CPU inventory can exceed the quota visible to Bun inside a container.
    return globalThis.navigator
      ? globalThis.navigator.hardwareConcurrency || 4
      : availableParallelism() || 4;
  } catch {
    return 4;
  }
})();

/**
 * `Bun.sleep` for Node.js, with Bun's semantics: a delay above 2^31 - 1 ms, and
 * Infinity, stay pending (a raw setTimeout ran them after about 1 ms) and keep the
 * process alive; NaN, negative and sub-millisecond delays resolve on the next timer
 * tick; a non-number throws a TypeError at once.
 */
export function sleep(ms: number): Promise<void> {
  if (typeof ms !== 'number') throw new TypeError('sleep expects a number (milliseconds)');
  return new Promise((resolve) => {
    // Infinity as the largest finite delay: never due, and, as in Bun, the pending
    // sleep keeps the process alive (safeTimeout arms nothing for Infinity itself).
    const delay = ms !== ms ? 0 : ms === Infinity ? Number.MAX_VALUE : ms;
    safeTimeout(() => resolve(), delay);
  });
}

/**
 * Pool identities need a stable token fingerprint, never the token itself: 64 bits of
 * SHA-256, as wide as `Bun.hash`, so two tokens never share a pool in practice.
 */
export function hash(value: string): bigint {
  return createHash('sha256').update(value).digest().readBigUInt64BE(0);
}

/** RFC 9562 UUIDv7, retaining the canonical public ID format. */
export function uuid(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function file(path: string): { exists(): Promise<boolean>; delete(): Promise<void> } {
  return {
    async exists() {
      try {
        await access(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    delete: () => unlink(path),
  };
}
