/**
 * Repro: a PostgreSQL session timeout below 1 ms in programmatic config became 1 ms.
 *
 * `resolvePostgresRuntimeConfig` raised every value below 1 to 1, so
 * `statementTimeoutMs: 0` (or a negative or sub-millisecond value) gave every pooled
 * connection `statement_timeout = 1ms` and failed nearly every statement, while a NaN
 * silently became the default. The server configuration (`src/config/settings.ts`)
 * rejects such values at startup; the programmatic path now rejects them too, with a
 * RangeError that names the setting, before any connection exists. No caller could
 * rely on the old result: a 1 ms timeout failed every statement.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresQueueStore } from '../src/infrastructure/persistence/postgres';
import { resolvePostgresRuntimeConfig } from '../src/infrastructure/persistence/postgres/runtimeConfig';

const url = 'postgres://bunqueue:test@localhost:5432/bunqueue';
const SETTINGS = ['statementTimeoutMs', 'lockTimeoutMs', 'idleTransactionTimeoutMs'] as const;
const RANGE = 'must be a finite number of milliseconds between 1 and 2147483647';

describe('PostgreSQL session timeouts in programmatic config', () => {
  test('reject a value below 1 ms, NaN, an infinity or one above PostgreSQL limit', () => {
    const invalid = [
      0,
      -0,
      -5,
      0.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
    ];
    for (const name of SETTINGS) {
      for (const value of invalid) {
        const resolve = () => resolvePostgresRuntimeConfig({ url, [name]: value });
        expect(resolve).toThrow(RangeError);
        expect(resolve).toThrow(`PostgreSQL storage ${name} ${RANGE}`);
      }
    }
  });

  test('a store with a 0 ms statement timeout is refused before it connects', () => {
    expect(
      () =>
        new PostgresQueueStore({
          url: 'postgres://bunqueue:unused@127.0.0.1:1/never',
          brokerId: 'session-timeout-zero',
          statementTimeoutMs: 0,
        })
    ).toThrow(`PostgreSQL storage statementTimeoutMs ${RANGE} (got 0)`);
  });

  test('keep the defaults when unset and an explicit value of at least 1 ms', () => {
    expect(resolvePostgresRuntimeConfig({ url })).toMatchObject({
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5_000,
      idleTransactionTimeoutMs: 30_000,
    });
    expect(
      resolvePostgresRuntimeConfig({
        url,
        statementTimeoutMs: 1,
        lockTimeoutMs: 75.9,
        idleTransactionTimeoutMs: 2_147_483_647,
      })
    ).toMatchObject({
      statementTimeoutMs: 1,
      lockTimeoutMs: 75,
      idleTransactionTimeoutMs: 2_147_483_647,
    });
  });
});
