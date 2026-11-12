/**
 * REPRO — issue #189: `reloadServerTls` reports a reload that left a listener neither
 * on the previous nor on the new certificate as `outcome: 'degraded'`, so the log can
 * never claim "still serving the previous certificate" when that is false.
 *
 * Run: bun test test/repro-issue-189-tls-reload-outcomes.test.ts
 *
 * - a target that cannot be rolled back (its `abort` throws) after another target
 *   refused the pair: degraded, and the error names both failures;
 * - a target whose `commit` throws: degraded.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { reloadServerTls } from '../src/infrastructure/server/tlsReload';
import { makeCertSet, type CertSet } from './tls-reload-support';

let set: CertSet;

beforeAll(() => {
  set = makeCertSet();
});

afterAll(() => {
  set.cleanup();
});

function tls() {
  return { certFile: set.live.cert, keyFile: set.live.key };
}

describe('issue #189: reloadServerTls outcomes', () => {
  test('a rollback or commit that fails is reported as degraded', () => {
    const brokenAbort = {
      prepareTlsReload() {
        return {
          commit: () => undefined,
          abort: () => {
            throw new Error('rebind lost');
          },
        };
      },
    };
    const failing = {
      prepareTlsReload(): never {
        throw new Error('bind refused');
      },
    };
    const rolledBack = reloadServerTls([brokenAbort, failing], tls());
    expect(rolledBack.ok).toBe(false);
    if (!rolledBack.ok) {
      expect(rolledBack.outcome).toBe('degraded');
      expect(rolledBack.error).toContain('bind refused');
      expect(rolledBack.error).toContain('rebind lost');
    }

    const brokenCommit = {
      prepareTlsReload() {
        return {
          commit: () => {
            throw new Error('swap lost');
          },
          abort: () => undefined,
        };
      },
    };
    const committed = reloadServerTls([brokenCommit], tls());
    expect(committed.ok).toBe(false);
    if (!committed.ok) {
      expect(committed.outcome).toBe('degraded');
      expect(committed.error).toContain('swap lost');
    }
  });
});
