/**
 * GroupConcurrencyLimiter - Per-group concurrency limiting for workers
 *
 * When a worker has limiter.groupKey set, this tracks how many jobs
 * are active per group and enforces the limiter.max cap per group.
 */

import type { RateLimiterOptions } from '../types';
import type { Job as InternalJob } from '../../domain/types/job';

/** Group key used when a group value can be neither read nor converted to a string. */
const UNPRINTABLE_GROUP_VALUE = '[bunqueue:unprintable-group-value]';

/**
 * Convert a producer-supplied group value into a stable Map key without ever
 * throwing. Template-literal conversion runs first so existing keys stay
 * identical (numbers, booleans, bigint, arrays, ordinary objects). A value whose
 * conversion throws, such as `{ toString: 'x' }` decoded from JSON or msgpack, a
 * null-prototype object or a symbol, falls back to its intrinsic
 * `Object.prototype.toString` tag, and finally to a constant.
 */
function toGroupKey(value: unknown): string {
  try {
    return `${value as string}`;
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNPRINTABLE_GROUP_VALUE;
    }
  }
}

export class GroupConcurrencyLimiter {
  private readonly groupKey: string;
  private readonly maxPerGroup: number;
  private readonly activeByGroup = new Map<string, number>();

  constructor(groupKey: string, max: number) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new RangeError('Worker group limiter max must be a positive integer');
    }
    this.groupKey = groupKey;
    this.maxPerGroup = max;
  }

  /**
   * Create a GroupConcurrencyLimiter from limiter options, or null if
   * groupKey is not configured.
   */
  static fromOptions(
    limiter: RateLimiterOptions | null | undefined
  ): GroupConcurrencyLimiter | null {
    if (!limiter?.groupKey) return null;
    return new GroupConcurrencyLimiter(limiter.groupKey, limiter.max);
  }

  /**
   * Extract the group key value from a job's data.
   * Returns null if the job data doesn't contain the group key field.
   * Total: never throws, because the ACK frontier, admission and group
   * accounting all call it on producer-controlled data.
   */
  getGroupValue(job: InternalJob): string | null {
    try {
      const data = job.data as Record<string, unknown> | null | undefined;
      if (!data || typeof data !== 'object') return null;
      const value = data[this.groupKey];
      if (value === undefined || value === null) return null;
      return typeof value === 'string' ? value : toGroupKey(value);
    } catch {
      return UNPRINTABLE_GROUP_VALUE;
    }
  }

  /**
   * Check if a job's group has capacity for another active job.
   * Jobs without a group value are always allowed (no group limit applies).
   */
  canProcess(job: InternalJob): boolean {
    const group = this.getGroupValue(job);
    if (group === null) return true;
    const current = this.activeByGroup.get(group) ?? 0;
    return current < this.maxPerGroup;
  }

  /**
   * Increment the active count for a job's group.
   * Call this when a job starts processing.
   */
  increment(job: InternalJob): void {
    const group = this.getGroupValue(job);
    if (group === null) return;
    const current = this.activeByGroup.get(group) ?? 0;
    this.activeByGroup.set(group, current + 1);
  }

  /**
   * Decrement the active count for a job's group.
   * Call this when a job finishes (completed or failed).
   */
  decrement(job: InternalJob): void {
    const group = this.getGroupValue(job);
    if (group === null) return;
    const current = this.activeByGroup.get(group) ?? 0;
    if (current <= 1) {
      this.activeByGroup.delete(group);
    } else {
      this.activeByGroup.set(group, current - 1);
    }
  }

  /** Get the current active count for a specific group. */
  getGroupCount(group: string): number {
    return this.activeByGroup.get(group) ?? 0;
  }

  /** Get max per group. */
  getMax(): number {
    return this.maxPerGroup;
  }

  /** Get the group key field name. */
  getGroupKey(): string {
    return this.groupKey;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.activeByGroup.clear();
  }
}
