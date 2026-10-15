import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJournal, runAgentEffect, AgentEffectUncertainError } from '../src/agents';

const dirs: string[] = [];
const journals: AgentJournal[] = [];
function location() {
  const dir = mkdtempSync(join(tmpdir(), 'bq-agent-journal-'));
  dirs.push(dir);
  return join(dir, 'journal.db');
}
function open(path = location(), options = {}) {
  const journal = new AgentJournal(path, options);
  journals.push(journal);
  return journal;
}
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('session checkpoints and completed effects survive reopen and remain isolated by run', async () => {
  const path = location();
  const a = open(path);
  a.checkpointSession('run-a', 'turn', 'session-a');
  let calls = 0;
  const invoke = () => {
    calls++;
    return Promise.resolve({ refundId: 'refund-a' });
  };
  expect(
    await runAgentEffect({
      journal: a,
      executionId: 'run-a',
      stepId: 'turn',
      callId: 'refund:order-a',
      invoke,
    })
  ).toEqual({ refundId: 'refund-a' });
  a.close();
  const b = open(path);
  expect(b.getSession('run-a', 'turn')).toBe('session-a');
  expect(b.getSession('run-b', 'turn')).toBeNull();
  expect(
    await runAgentEffect({
      journal: b,
      executionId: 'run-a',
      stepId: 'turn',
      callId: 'refund:order-a',
      invoke,
    })
  ).toEqual({ refundId: 'refund-a' });
  expect(calls).toBe(1);
  await runAgentEffect({
    journal: b,
    executionId: 'run-b',
    stepId: 'turn',
    callId: 'refund:order-a',
    invoke,
  });
  expect(calls).toBe(2);
});

test('foreign dormant WAL database is refused without altering bytes or creating sidecars', () => {
  const path = location();
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT); INSERT INTO jobs VALUES ('queue-job')"
  );
  db.close();
  const before = readFileSync(path);
  const files = readdirSync(join(path, '..'));
  expect(() => open(path)).toThrow('journal');
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(join(path, '..'))).toEqual(files);
  const check = new Database(path, { readonly: true });
  try {
    expect(check.query('SELECT id FROM jobs').get()).toEqual({ id: 'queue-job' });
  } finally {
    check.close();
  }
});

test('unsupported journal version is refused before SQLite opens the dormant WAL file', () => {
  const path = location();
  open(path).close();
  const db = new Database(path);
  db.exec('PRAGMA user_version=999; PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const bytes = readFileSync(path);
  const files = readdirSync(join(path, '..'));
  expect(() => open(path)).toThrow('version');
  expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(join(path, '..'))).toEqual(files);
});

test('unsupported schema committed only in WAL is refused without creating SHM', () => {
  const original = location();
  open(original).close();
  const db = new Database(original);
  db.exec('PRAGMA user_version=999');
  const path = location();
  copyFileSync(original, path);
  copyFileSync(`${original}-wal`, `${path}-wal`);
  db.close();
  const before = readFileSync(`${path}-wal`);
  const files = readdirSync(join(path, '..'));
  expect(() => open(path)).toThrow('version');
  expect(readdirSync(join(path, '..'))).toEqual(files);
  expect(readFileSync(`${path}-wal`)).toEqual(before);
});

test('preflight validates the latest committed WAL metadata rather than superseded frames', () => {
  const original = location();
  open(original).close();
  const db = new Database(original);
  db.exec('PRAGMA user_version=999; PRAGMA user_version=1');
  const path = location();
  copyFileSync(original, path);
  copyFileSync(`${original}-wal`, `${path}-wal`);
  db.close();
  const reopened = open(path);
  reopened.checkpointSession('run', 'turn', 'restored');
  expect(reopened.getSession('run', 'turn')).toBe('restored');
});

test('a callback failure immediately exposes uncertain outcome and preserves the original cause', async () => {
  const journal = open();
  const cause = new Error('response lost after remote commit');
  const promise = runAgentEffect({
    journal,
    executionId: 'run',
    stepId: 'turn',
    callId: 'remote:1',
    invoke: async () => {
      throw cause;
    },
  });
  await expect(promise).rejects.toBeInstanceOf(AgentEffectUncertainError);
  await expect(promise).rejects.toMatchObject({ cause });
});

test('non-JSON effect results remain uncertain instead of changing value on replay', async () => {
  const journal = open();
  const args = { journal, executionId: 'run', stepId: 'turn', callId: 'payment:bad-result' };
  await expect(
    runAgentEffect({ ...args, invoke: async () => ({ amount: NaN }) })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  await expect(
    runAgentEffect({ ...args, invoke: async () => ({ amount: 1 }) })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
});

test('cross-connection duplicate pending effects refuse a second external operation', async () => {
  const path = location();
  const a = open(path);
  const b = open(path);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const args = { executionId: 'run', stepId: 'turn', callId: 'charge:invoice-1' };
  const first = runAgentEffect({
    ...args,
    journal: a,
    invoke: async () => {
      calls++;
      await wait;
      return 'paid';
    },
  });
  await expect(
    runAgentEffect({
      ...args,
      journal: b,
      invoke: async () => {
        calls++;
        return 'duplicate';
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  expect(calls).toBe(1);
  release();
  expect(await first).toBe('paid');
  expect(await runAgentEffect({ ...args, journal: b, invoke: async () => 'duplicate' })).toBe(
    'paid'
  );
});

test('callback failure persists uncertainty and reconciliation prevents repeating an applied effect', async () => {
  const path = location();
  const journal = open(path);
  const args = { journal, executionId: 'run', stepId: 'turn', callId: 'charge:invoice-2' };
  let calls = 0;
  await expect(
    runAgentEffect({
      ...args,
      invoke: async () => {
        calls++;
        throw new Error('response lost after charge');
      },
    })
  ).rejects.toMatchObject({ cause: { message: 'response lost after charge' } });
  journal.close();
  const reopened = open(path);
  await expect(
    runAgentEffect({
      ...args,
      journal: reopened,
      invoke: async () => {
        calls++;
        return 'duplicate';
      },
    })
  ).rejects.toBeInstanceOf(AgentEffectUncertainError);
  expect(
    await runAgentEffect({
      ...args,
      journal: reopened,
      invoke: async () => {
        calls++;
        return 'duplicate';
      },
      reconcile: async () => ({ status: 'completed', result: 'charge-confirmed' }),
    })
  ).toBe('charge-confirmed');
  expect(calls).toBe(1);
});

test('competing reconciliation callbacks cannot both retry a proven non-applied effect', async () => {
  const path = location();
  const a = open(path);
  const b = open(path);
  const args = { executionId: 'run', stepId: 'turn', callId: 'order:3' };
  await expect(
    runAgentEffect({
      ...args,
      journal: a,
      invoke: async () => {
        throw new Error('lost');
      },
    })
  ).rejects.toThrow();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const reconcile = async () => {
    await wait;
    return { status: 'not_applied' as const };
  };
  const invoke = async () => {
    calls++;
    return 'issued';
  };
  const first = runAgentEffect({ ...args, journal: a, invoke, reconcile });
  const second = runAgentEffect({ ...args, journal: b, invoke, reconcile });
  release();
  const settled = await Promise.allSettled([first, second]);
  expect(calls).toBe(1);
  expect(settled.some((result) => result.status === 'fulfilled' && result.value === 'issued')).toBe(
    true
  );
});

test('bounded per-run replay reports actual retention gaps rather than interleaved global cursors', () => {
  const journal = open(location(), { maxEventsPerRun: 2, maxEventBytes: 256 });
  const first = journal.append('a', 'turn', {
    type: 'progress',
    message: 'first',
    prompt: 'SECRET',
  } as never);
  journal.append('b', 'turn', { type: 'progress', message: 'other' });
  const second = journal.append('a', 'turn', { type: 'progress', message: 'second' });
  expect(journal.replay('a', { after: first }).gap).toBeNull();
  journal.append('b', 'turn', { type: 'progress', message: 'other again' });
  journal.append('a', 'turn', { type: 'progress', message: 'third' });
  const replay = journal.replay('a', { after: 0, limit: 1 });
  expect(replay.gap).toEqual({ droppedThrough: first });
  expect(replay.events.map((event) => event.cursor)).toEqual([second]);
  expect(replay.nextCursor).toBe(second);
  expect(journal.replay('b', { after: 0 }).gap).toBeNull();
  expect(() =>
    journal.append('a', 'turn', { type: 'progress', message: 'x'.repeat(1000) })
  ).toThrow('bytes');
  expect(() => journal.replay('a', { limit: Infinity })).toThrow();
  expect(JSON.stringify(journal.replay('a'))).not.toContain('SECRET');
});
