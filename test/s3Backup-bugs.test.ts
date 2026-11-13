/**
 * S3 Backup Bug Reproduction Tests
 *
 * Each test reproduces a specific bug found during analysis.
 * Tests are written FIRST (failing), then code is fixed to make them pass.
 */

import { describe, test, expect } from 'bun:test';
import { validateConfig, DEFAULTS } from '../src/infrastructure/backup/s3BackupConfig';
import type { S3BackupConfig } from '../src/infrastructure/backup/s3BackupConfig';

function cfg(overrides: Partial<S3BackupConfig> = {}): S3BackupConfig {
  return {
    enabled: true,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    bucket: 'test-bucket',
    region: 'us-east-1',
    intervalMs: DEFAULTS.intervalMs,
    retention: DEFAULTS.retention,
    prefix: DEFAULTS.prefix,
    databasePath: '/tmp/test.db',
    ...overrides,
  };
}

// =============================================================================
// BUG 1: validateConfig accepts retention=0 (deletes all backups)
// =============================================================================
describe('BUG: validateConfig accepts dangerous retention values', () => {
  test('rejects retention of 0', () => {
    const r = validateConfig(cfg({ retention: 0 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes('retention'))).toBe(true);
  });

  test('rejects negative retention', () => {
    const r = validateConfig(cfg({ retention: -5 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes('retention'))).toBe(true);
  });
});

// =============================================================================
// BUG 2: validateConfig accepts intervalMs=0 (CPU spin)
// =============================================================================
describe('BUG: validateConfig accepts dangerous interval values', () => {
  test('rejects intervalMs of 0', () => {
    const r = validateConfig(cfg({ intervalMs: 0 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes('interval'))).toBe(true);
  });

  test('rejects negative intervalMs', () => {
    const r = validateConfig(cfg({ intervalMs: -1000 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes('interval'))).toBe(true);
  });

  test('rejects intervalMs below minimum (60 seconds)', () => {
    const r = validateConfig(cfg({ intervalMs: 1000 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes('interval'))).toBe(true);
  });
});

// BUG 3 (a metadata-less compressed backup is restored) and BUG 4 (retention=0
// deletes every backup) are covered by repro-s3-backup-production.test.ts and
// repro-config-s3-backup.test.ts.
