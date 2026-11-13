/**
 * Comprehensive tests for client-side DLQ and Deduplication modules
 * Tests: dlq.ts, dlqOps.ts (empty DLQ, configuration, retryCompleted)
 *
 * Run with: BUNQUEUE_EMBEDDED=1 bun test test/client-dlq-dedup-config.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, shutdownManager } from '../src/client';

// ============================================================
// DLQ OPERATIONS (src/client/queue/dlq.ts, dlqOps.ts)
// ============================================================
describe('DLQ Operations', () => {
  let queue: Queue<Record<string, unknown>>;
  const QUEUE_NAME = 'dlq-test';

  beforeEach(() => {
    queue = new Queue(QUEUE_NAME);
  });

  afterEach(() => {
    shutdownManager();
  });

  // ---- Empty DLQ Edge Cases ----
  describe('empty DLQ', () => {
    it('should return empty array from getDlq when no DLQ entries exist', () => {
      const entries = queue.getDlq();
      expect(entries).toEqual([]);
    });

    it('should return 0 from retryDlq when DLQ is empty', () => {
      const count = queue.retryDlq();
      expect(count).toBe(0);
    });

    it('should return 0 from purgeDlq when DLQ is empty', () => {
      const count = queue.purgeDlq();
      expect(count).toBe(0);
    });

    it('should return zero-filled stats from getDlqStats when DLQ is empty', () => {
      const stats = queue.getDlqStats();
      expect(stats.total).toBe(0);
      expect(stats.pendingRetry).toBe(0);
      expect(stats.expired).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    it('should return 0 from retryDlqByFilter when DLQ is empty', () => {
      const count = queue.retryDlqByFilter({ reason: 'max_attempts_exceeded' });
      expect(count).toBe(0);
    });
  });

  // ---- getDlqConfig / setDlqConfig ----
  describe('getDlqConfig / setDlqConfig', () => {
    it('should return default DLQ config', () => {
      const config = queue.getDlqConfig();
      expect(config).toBeDefined();
      expect(config.autoRetry).toBe(false);
      expect(config.maxAutoRetries).toBe(3);
      expect(config.maxEntries).toBe(10000);
      expect(config.maxAge).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
    });

    it('should set and get custom DLQ config', () => {
      queue.setDlqConfig({
        autoRetry: true,
        maxAutoRetries: 5,
        maxAge: 3600000, // 1 hour
        maxEntries: 500,
      });

      const config = queue.getDlqConfig();
      expect(config.autoRetry).toBe(true);
      expect(config.maxAutoRetries).toBe(5);
      expect(config.maxAge).toBe(3600000);
      expect(config.maxEntries).toBe(500);
    });

    it('should partially update DLQ config', () => {
      queue.setDlqConfig({ autoRetry: true });

      const config = queue.getDlqConfig();
      expect(config.autoRetry).toBe(true);
      // Other defaults should remain
      expect(config.maxAutoRetries).toBe(3);
    });

    it('should set maxAge to null to disable auto-purge', () => {
      queue.setDlqConfig({ maxAge: null });

      const config = queue.getDlqConfig();
      expect(config.maxAge).toBeNull();
    });
  });

  describe('setDlqConfigAsync', () => {
    it('round-trips through getDlqConfig', async () => {
      await queue.setDlqConfigAsync({ autoRetry: true, maxEntries: 123 });

      const config = queue.getDlqConfig();
      expect(config.autoRetry).toBe(true);
      expect(config.maxEntries).toBe(123);
    });
  });

  // ---- DLQ config behavior ----
  describe('DLQ auto-retry config', () => {
    it('should configure auto-retry settings', () => {
      queue.setDlqConfig({
        autoRetry: true,
        autoRetryInterval: 5000,
        maxAutoRetries: 2,
      });

      const config = queue.getDlqConfig();
      expect(config.autoRetry).toBe(true);
      expect(config.autoRetryInterval).toBe(5000);
      expect(config.maxAutoRetries).toBe(2);
    });
  });

  describe('DLQ maxAge config', () => {
    it('should set and get maxAge', () => {
      queue.setDlqConfig({ maxAge: 86400000 }); // 1 day

      const config = queue.getDlqConfig();
      expect(config.maxAge).toBe(86400000);
    });
  });

  describe('DLQ maxEntries config', () => {
    it('should set and get maxEntries', () => {
      queue.setDlqConfig({ maxEntries: 100 });

      const config = queue.getDlqConfig();
      expect(config.maxEntries).toBe(100);
    });
  });

  // ---- Retry completed job ----
  describe('retryCompleted', () => {
    it('should return 0 when no completed jobs exist', () => {
      const count = queue.retryCompleted();
      expect(count).toBe(0);
    });

    it('should return 0 for a non-existent completed job ID', () => {
      const count = queue.retryCompleted('non-existent');
      expect(count).toBe(0);
    });
  });
});
