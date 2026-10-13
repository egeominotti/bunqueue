import type { UniqueKeyEntry } from '../../types/deduplication';
import type { JobId } from '../../types/job';
import { ShardState } from './state';

/** Deduplication keys and per-job group slot ownership. */
export class ShardKeys extends ShardState {
  isUniqueAvailable(queue: string, key: string): boolean {
    return this.uniqueKeyManager.isAvailable(queue, key);
  }
  getUniqueKeyEntry(queue: string, key: string): UniqueKeyEntry | null {
    return this.uniqueKeyManager.getEntry(queue, key);
  }
  registerUniqueKey(queue: string, key: string, jobId: JobId): void {
    this.uniqueKeyManager.register(queue, key, jobId);
  }
  registerUniqueKeyWithTtl(queue: string, key: string, jobId: JobId, ttl?: number): void {
    this.uniqueKeyManager.registerWithTtl(queue, key, jobId, ttl);
  }
  extendUniqueKeyTtl(queue: string, key: string, ttl: number): boolean {
    return this.uniqueKeyManager.extendTtl(queue, key, ttl);
  }
  releaseUniqueKey(queue: string, key: string): boolean {
    return this.uniqueKeyManager.release(queue, key);
  }
  releaseUniqueKeyIfOwned(queue: string, key: string, ownerId: JobId): boolean {
    return this.uniqueKeyManager.releaseIfOwned(queue, key, ownerId);
  }
  cleanExpiredUniqueKeys(): number {
    return this.uniqueKeyManager.cleanExpired();
  }
  get uniqueKeys(): Map<string, Map<string, UniqueKeyEntry>> {
    return this.uniqueKeyManager.getMap();
  }
  isGroupActive(queue: string, groupId: string): boolean {
    return (this.activeGroupCounts.get(queue)?.get(groupId) ?? 0) > 0;
  }
  /**
   * Record that active job `jobId` holds a slot of its group. A job holds at most
   * one slot: activating a holder again changes nothing.
   */
  activateGroup(queue: string, groupId: string, jobId: JobId): void {
    let holders = this.activeGroupHolders.get(queue);
    if (!holders) {
      holders = new Map();
      this.activeGroupHolders.set(queue, holders);
    }
    if (holders.get(jobId) === groupId) return;
    holders.set(jobId, groupId);
    let groups = this.activeGroups.get(queue);
    if (!groups) {
      groups = new Set();
      this.activeGroups.set(queue, groups);
    }
    groups.add(groupId);
    let counts = this.activeGroupCounts.get(queue);
    if (!counts) {
      counts = new Map();
      this.activeGroupCounts.set(queue, counts);
    }
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  /**
   * Release the group slot held by `jobId`. A job that holds no slot of this group
   * (already released, never active, or of another group) changes nothing, so a
   * duplicate or late release can never free a slot another job still holds.
   */
  releaseGroup(queue: string, groupId: string, jobId: JobId): void {
    const holders = this.activeGroupHolders.get(queue);
    if (holders?.get(jobId) !== groupId) return;
    holders.delete(jobId);
    if (holders.size === 0) this.activeGroupHolders.delete(queue);
    const counts = this.activeGroupCounts.get(queue);
    const count = (counts?.get(groupId) ?? 0) - 1;
    if (count > 0) {
      counts?.set(groupId, count);
    } else {
      counts?.delete(groupId);
      const groups = this.activeGroups.get(queue);
      groups?.delete(groupId);
      if (groups?.size === 0) this.activeGroups.delete(queue);
    }
    if (counts?.size === 0) this.activeGroupCounts.delete(queue);
    this.notify(queue);
  }
  getGroupActiveCount(queue: string, groupId: string): number {
    return this.activeGroupCounts.get(queue)?.get(groupId) ?? 0;
  }
  /** Forget every active group slot of the queue (obliterate, empty-queue cleanup). */
  protected clearActiveGroups(queue: string): void {
    this.activeGroups.delete(queue);
    this.activeGroupCounts.delete(queue);
    this.activeGroupHolders.delete(queue);
  }
}
