/**
 * The SQLite header guard of restoreBackup (s3BackupOperations.ts).
 *
 * SQLite opens a zero-byte file as a valid empty database, and `PRAGMA integrity_check`
 * answers `ok` for it, so an empty backup object passes every other check: a legacy
 * payload has no checksum, and a current-format one can carry metadata that matches
 * the empty payload. The `SQLite format 3` header check is the only step that refuses
 * it. Without it, restore reports success and replaces the live database with an empty
 * file. These tests restore such payloads over a database with rows and require the
 * header refusal, the rows intact and no candidate file left behind.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Client } from 'bun';
import type { S3BackupConfig } from '../src/infrastructure/backup/s3BackupConfig';
import { DEFAULTS } from '../src/infrastructure/backup/s3BackupConfig';
import { gzipAsync, sha256 } from '../src/infrastructure/backup/s3BackupIo';
import { restoreBackup } from '../src/infrastructure/backup/s3BackupOperations';

const HEADER_ERROR = 'Restored data is not a valid SQLite database';
const KEY = 'backups/bunqueue-header-guard.db';

let dir = '';
let databasePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-restore-header-'));
  databasePath = join(dir, 'live.db');
  const db = new Database(databasePath);
  db.run('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)');
  db.run("INSERT INTO rows (value) VALUES ('kept-1'), ('kept-2')");
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An in-memory S3 client holding `objects` (key -> bytes). */
function s3With(objects: Record<string, Uint8Array>): S3Client {
  return {
    file(key: string) {
      return {
        exists: async () => key in objects,
        arrayBuffer: async () => {
          const bytes = objects[key];
          if (!bytes) throw new Error(`Not found: ${key}`);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        json: async () => JSON.parse(new TextDecoder().decode(objects[key])),
      };
    },
  } as unknown as S3Client;
}

function config(): S3BackupConfig {
  return {
    enabled: true,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    bucket: 'test-bucket',
    region: 'us-east-1',
    intervalMs: DEFAULTS.intervalMs,
    retention: DEFAULTS.retention,
    prefix: DEFAULTS.prefix,
    databasePath,
    timeoutMs: 5_000,
  };
}

/** A current-format backup pair (gzip payload + metadata that matches it). */
async function currentFormat(payload: Uint8Array): Promise<Record<string, Uint8Array>> {
  const compressed = await gzipAsync(payload);
  const metadata = {
    timestamp: new Date().toISOString(),
    version: '1.0',
    size: payload.byteLength,
    compressedSize: compressed.byteLength,
    checksum: sha256(payload),
    compressed: true,
  };
  return {
    [KEY]: compressed,
    [`${KEY}.meta.json`]: new TextEncoder().encode(JSON.stringify(metadata)),
  };
}

function liveRows(): string[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db.query('SELECT value FROM rows ORDER BY id').all() as { value: string }[];
    return rows.map((row) => row.value);
  } finally {
    db.close();
  }
}

/** Files in the test directory other than the live database itself. */
function strayFiles(): string[] {
  return readdirSync(dir).filter((name) => name !== 'live.db');
}

describe('restoreBackup SQLite header guard', () => {
  test('an empty file is a valid empty database to SQLite (why the guard is needed)', async () => {
    const empty = join(dir, 'empty.db');
    await Bun.write(empty, new Uint8Array(0));
    const db = new Database(empty, { readonly: true });
    try {
      expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
    }
    rmSync(empty);
  });

  test('an empty legacy payload is refused and the live database is kept', async () => {
    const result = await restoreBackup(KEY, config(), s3With({ [KEY]: new Uint8Array(0) }));
    expect(result).toEqual({ success: false, error: HEADER_ERROR });
    expect(liveRows()).toEqual(['kept-1', 'kept-2']);
    expect(strayFiles()).toEqual([]);
  });

  test('an empty current-format payload with matching metadata is refused', async () => {
    const objects = await currentFormat(new Uint8Array(0));
    const result = await restoreBackup(KEY, config(), s3With(objects));
    expect(result).toEqual({ success: false, error: HEADER_ERROR });
    expect(liveRows()).toEqual(['kept-1', 'kept-2']);
    expect(strayFiles()).toEqual([]);
  });

  test('a payload that does not start with the header is refused by the guard', async () => {
    const payload = new TextEncoder().encode('not a database, just text\n');
    const result = await restoreBackup(KEY, config(), s3With(await currentFormat(payload)));
    expect(result).toEqual({ success: false, error: HEADER_ERROR });
    expect(liveRows()).toEqual(['kept-1', 'kept-2']);
  });

  test('a real SQLite payload still restores (control)', async () => {
    const sourcePath = join(dir, 'source.db');
    const source = new Database(sourcePath);
    source.run('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)');
    source.run("INSERT INTO rows (value) VALUES ('restored')");
    source.close();
    const payload = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
    rmSync(sourcePath);

    const result = await restoreBackup(KEY, config(), s3With(await currentFormat(payload)));
    expect(result.success).toBe(true);
    expect(liveRows()).toEqual(['restored']);
  });
});
