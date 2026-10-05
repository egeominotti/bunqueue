/**
 * Repro: the PostgreSQL runtime accepted every finite duration above its floors.
 *
 * `leaseDurationMs` and `pollIntervalMs` only had lower floors, so a value that is not
 * an exact integer reached deadline arithmetic and the maintenance timers, and the
 * three PostgreSQL session timeouts accepted values that PostgreSQL itself rejects
 * (`invalid value for parameter "statement_timeout"`) only once the pool connects.
 */
import { describe, expect, test } from 'bun:test';
import { resolvePostgresRuntimeConfig } from '../src/infrastructure/persistence/postgres/runtimeConfig';

const url = 'postgres://bunqueue:test@localhost:5432/bunqueue';
const POSTGRES_MAX_SESSION_TIMEOUT_MS = 2_147_483_647;

describe('PostgreSQL runtime duration bounds', () => {
  test('rejects a lease or poll interval that is not an exact whole millisecond count', () => {
    for (const name of ['leaseDurationMs', 'pollIntervalMs'] as const) {
      for (const value of [Number.MAX_SAFE_INTEGER + 2, 1e20, Number.MAX_VALUE]) {
        expect(() => resolvePostgresRuntimeConfig({ url, [name]: value })).toThrow(RangeError);
        expect(() => resolvePostgresRuntimeConfig({ url, [name]: value })).toThrow(name);
      }
    }
  });

  test('rejects session timeouts PostgreSQL cannot represent, naming the setting', () => {
    for (const name of [
      'statementTimeoutMs',
      'lockTimeoutMs',
      'idleTransactionTimeoutMs',
    ] as const) {
      const value = POSTGRES_MAX_SESSION_TIMEOUT_MS + 1;
      expect(() => resolvePostgresRuntimeConfig({ url, [name]: value })).toThrow(RangeError);
      expect(() => resolvePostgresRuntimeConfig({ url, [name]: value })).toThrow(
        `${name} must be a finite number of milliseconds between 1 and ${POSTGRES_MAX_SESSION_TIMEOUT_MS}`
      );
    }
  });

  test('honours every representable value beyond the native timer limit', () => {
    const resolved = resolvePostgresRuntimeConfig({
      url,
      leaseDurationMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: 2 ** 31,
      statementTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
      lockTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
      idleTransactionTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
    });
    expect(resolved).toMatchObject({
      leaseDurationMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: 2 ** 31,
      statementTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
      lockTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
      idleTransactionTimeoutMs: POSTGRES_MAX_SESSION_TIMEOUT_MS,
    });
  });

  test('keeps the documented runtime minimums and defaults', () => {
    const raised = resolvePostgresRuntimeConfig({
      url,
      leaseDurationMs: 10,
      pollIntervalMs: -5,
    });
    // Session timeouts are not raised: below 1 ms they are rejected
    // (repro-postgres-timers-session-timeouts.test.ts).
    expect(raised).toMatchObject({ leaseDurationMs: 1000, pollIntervalMs: 25 });
    const fractional = resolvePostgresRuntimeConfig({ url, leaseDurationMs: 1500.9 });
    expect(fractional.leaseDurationMs).toBe(1500);
    const defaults = resolvePostgresRuntimeConfig({
      url,
      leaseDurationMs: Number.NEGATIVE_INFINITY,
      pollIntervalMs: Number.POSITIVE_INFINITY,
    });
    expect(defaults).toMatchObject({ leaseDurationMs: 30_000, pollIntervalMs: 250 });
  });
});
