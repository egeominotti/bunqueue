import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from 'node:fs';

// Written to the main database before WAL is enabled, so refusal needs no SQLite open.
const APPLICATION_ID = 0x4251414a;
const VERSION = 1;

function validateHeader(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(100);
    const size = readSync(fd, header, 0, header.length, 0);
    if (
      size !== 100 ||
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header.readUInt32BE(68) !== APPLICATION_ID
    ) {
      throw new Error('Existing file is not an agent journal');
    }
    if (header.readUInt32BE(60) !== VERSION) throw new Error('Unsupported agent journal version');
  } finally {
    closeSync(fd);
  }
  validateWalHeader(path);
}

/** A committed page-one WAL frame can supersede the main file's version/owner. */
function validateWalHeader(path: string): void {
  let fd: number;
  try {
    fd = openSync(`${path}-wal`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const header = Buffer.alloc(32);
    if (readSync(fd, header, 0, 32, 0) < 32) return;
    const magic = header.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error('Invalid agent journal WAL');
    const pageSize = header.readUInt32BE(8);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error('Invalid agent journal WAL page size');
    }
    const size = fstatSync(fd).size;
    const frame = Buffer.alloc(24);
    const page = Buffer.alloc(100);
    let pending: { owner: number; version: number } | undefined;
    let committed: typeof pending;
    for (let offset = 32; offset + 24 + pageSize <= size; offset += 24 + pageSize) {
      readSync(fd, frame, 0, 24, offset);
      // Frames from an earlier WAL generation are ignored by SQLite too.
      if (!frame.subarray(8, 16).equals(header.subarray(16, 24))) break;
      if (frame.readUInt32BE(0) === 1) {
        readSync(fd, page, 0, 100, offset + 24);
        pending = { owner: page.readUInt32BE(68), version: page.readUInt32BE(60) };
      }
      if (frame.readUInt32BE(4) !== 0 && pending) {
        committed = pending;
        pending = undefined;
      }
    }
    if (committed && committed.owner !== APPLICATION_ID)
      throw new Error('Existing WAL is not an agent journal');
    if (committed && committed.version !== VERSION)
      throw new Error('Unsupported agent journal version in WAL');
  } finally {
    closeSync(fd);
  }
}

const SCHEMA = `
  CREATE TABLE sessions (
    execution_id TEXT NOT NULL, step_id TEXT NOT NULL, session_id TEXT NOT NULL,
    PRIMARY KEY (execution_id, step_id)
  );
  CREATE TABLE events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL,
    step_id TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX events_run_cursor ON events(execution_id, cursor);
  CREATE TABLE retention (execution_id TEXT PRIMARY KEY, dropped_through INTEGER NOT NULL);
  CREATE TABLE effects (
    execution_id TEXT NOT NULL, step_id TEXT NOT NULL, call_id TEXT NOT NULL,
    token TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
    result TEXT, PRIMARY KEY (execution_id, step_id, call_id)
  );
`;

/** Refuse foreign files before SQLite can create WAL/SHM or perform recovery. */
export function openJournalDatabase(path: string): Database {
  if (path === ':memory:' || !path) throw new Error('Agent journal requires a dedicated file path');
  let created = false;
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) {
    let initial: Database | undefined;
    try {
      const initializing = new Database(path, { strict: true });
      initial = initializing;
      initializing
        .transaction(() => {
          initializing.exec(
            `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};`
          );
          initializing.exec(SCHEMA);
        })
        .immediate();
    } catch (error) {
      initial?.close();
      unlinkSync(path);
      throw error;
    }
    initial.close();
  }
  validateHeader(path);
  const db = new Database(path, { strict: true });
  try {
    // Verify the committed SQLite metadata as well (a WAL may contain a newer version).
    if (
      (db.query('PRAGMA application_id').get() as { application_id: number }).application_id !==
        APPLICATION_ID ||
      (db.query('PRAGMA user_version').get() as { user_version: number }).user_version !== VERSION
    ) {
      throw new Error('Unsupported agent journal version or ownership');
    }
    db.query('SELECT execution_id, step_id, session_id FROM sessions LIMIT 0').all();
    db.query('SELECT cursor, execution_id, step_id, payload FROM events LIMIT 0').all();
    db.query('SELECT execution_id, dropped_through FROM retention LIMIT 0').all();
    db.query(
      'SELECT execution_id, step_id, call_id, token, status, result FROM effects LIMIT 0'
    ).all();
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
