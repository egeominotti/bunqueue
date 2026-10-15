import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDatabaseCandidate } from '../src/infrastructure/backup/sqliteBackupFiles';

async function interruptBeforeSwap(livePath: string, candidatePath: string): Promise<void> {
  const modulePath = new URL('../src/infrastructure/backup/sqliteBackupFiles.ts', import.meta.url)
    .pathname;
  const interrupted = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { mock } from 'bun:test';
     const fs = await import('node:fs/promises');
     const rename = fs.rename;
     const livePath = ${JSON.stringify(livePath)};
     const candidatePath = ${JSON.stringify(candidatePath)};
     mock.module('node:fs/promises', () => ({ ...fs, rename: async (from, to) => {
       if (from === candidatePath) process.kill(process.pid, 'SIGKILL');
       await rename(from, to);
       if (from === livePath + '-wal' || from === livePath + '-journal') {
         process.kill(process.pid, 'SIGKILL');
       }
     }}));
     const { installDatabaseCandidate } = await import(${JSON.stringify(modulePath)});
     await installDatabaseCandidate(candidatePath, livePath);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await interrupted.exited).toBe(137);
}

test('interrupted restore preserves committed WAL rows until the replacement is installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunqueue-restore-interruption-'));
  const livePath = join(dir, 'live.db');
  const candidatePath = join(dir, 'candidate.db');
  try {
    const writer = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { Database } from 'bun:sqlite';
       const db = new Database(${JSON.stringify(livePath)});
       db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE state(value TEXT); PRAGMA wal_checkpoint(TRUNCATE)');
       db.run("INSERT INTO state VALUES ('original-committed')");
       process.kill(process.pid, 'SIGKILL');`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(await writer.exited).toBe(137);
    expect(Bun.file(`${livePath}-wal`).size).toBeGreaterThan(0);

    const candidate = new Database(candidatePath);
    candidate.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('backup')");
    candidate.close();

    await interruptBeforeSwap(livePath, candidatePath);

    const reopened = new Database(livePath);
    try {
      expect(reopened.query('SELECT value FROM state').all()).toEqual([
        { value: 'original-committed' },
      ]);
      expect(reopened.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('interrupted restore recovers a hot rollback journal before detaching sidecars', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunqueue-restore-hot-journal-'));
  const livePath = join(dir, 'live.db');
  const candidatePath = join(dir, 'candidate.db');
  try {
    const original = new Database(livePath);
    original.exec(
      'PRAGMA journal_mode=DELETE; CREATE TABLE state(value TEXT, payload BLOB); ' +
        'WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<200) ' +
        "INSERT INTO state SELECT 'original-committed', zeroblob(1000) FROM rows"
    );
    original.close();
    const before = await Bun.file(livePath).bytes();
    const writer = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { Database } from 'bun:sqlite';
       const db = new Database(${JSON.stringify(livePath)});
       db.exec('PRAGMA cache_size=5; PRAGMA cache_spill=1; BEGIN');
       db.run("UPDATE state SET value='uncommitted', payload=randomblob(1000)");
       process.kill(process.pid, 'SIGKILL');`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(await writer.exited).toBe(137);
    expect(Bun.file(`${livePath}-journal`).size).toBeGreaterThan(512);
    expect(await Bun.file(livePath).bytes()).not.toEqual(before);

    const candidate = new Database(candidatePath);
    candidate.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('backup')");
    candidate.close();
    await interruptBeforeSwap(livePath, candidatePath);

    const reopened = new Database(livePath);
    try {
      expect(
        reopened.query('SELECT value, COUNT(*) AS count FROM state GROUP BY value').all()
      ).toEqual([{ value: 'original-committed', count: 200 }]);
      expect(reopened.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore preserves the unreadable main file and candidate when recovery cannot run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunqueue-restore-unreadable-'));
  const livePath = join(dir, 'live.db');
  const candidatePath = join(dir, 'candidate.db');
  try {
    await Bun.write(livePath, 'invalid original database');
    await Bun.write(`${livePath}-journal`, 'original journal');
    const candidate = new Database(candidatePath);
    candidate.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('backup')");
    candidate.close();

    await expect(installDatabaseCandidate(candidatePath, livePath)).rejects.toThrow();
    expect(await Bun.file(livePath).text()).toBe('invalid original database');
    expect(await Bun.file(candidatePath).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore refuses to detach WAL while a reader prevents a complete checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunqueue-restore-busy-'));
  const livePath = join(dir, 'live.db');
  const candidatePath = join(dir, 'candidate.db');
  const writer = new Database(livePath);
  const reader = new Database(livePath);
  try {
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ' +
        'CREATE TABLE state(value TEXT); PRAGMA wal_checkpoint(TRUNCATE)'
    );
    reader.exec('BEGIN');
    reader.query('SELECT * FROM state').all();
    writer.run("INSERT INTO state VALUES ('original-committed')");
    const candidate = new Database(candidatePath);
    candidate.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('backup')");
    candidate.close();

    await expect(installDatabaseCandidate(candidatePath, livePath)).rejects.toThrow(/busy|locked/i);
    expect(await Bun.file(candidatePath).exists()).toBe(true);
    expect(writer.query('SELECT value FROM state').all()).toEqual([
      { value: 'original-committed' },
    ]);
  } finally {
    try {
      reader.exec('ROLLBACK');
    } catch {
      /* The assertion may fail before a transaction starts. */
    }
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
