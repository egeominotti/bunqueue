import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitJobUntilFinished } from '../src/client/jobWait';
import { readSchedulerFor } from '../src/client/job-wait/readScheduler';
import { JobWaitSession } from '../src/client/job-wait/session';

// A settled wait must stop costing anything: no further WaitJob holds or state reads,
// and no timer of its own (a pacing pause, a scheduled re-read) keeping the process
// alive. A hold already in flight cannot be withdrawn from the broker; it ends with its
// own timeout and is not followed by another. Conversely, a wait that has not settled
// must not let a script awaiting it exit early: the TTL keeps the process alive until
// the wait has settled, including the bounded read made when the TTL elapses.
// Process timings use margins of seconds, so a loaded CI container cannot flip them.

setDefaultTimeout(30_000);

/** A broker double: WaitJob answers `completed: false` when its hold ends. */
function holdingTransport() {
  const sent: string[] = [];
  return {
    sent,
    send(command: Record<string, unknown>) {
      sent.push(command.cmd as string);
      if (command.cmd !== 'WaitJob') return Promise.resolve({ ok: true, state: 'waiting' });
      return Bun.sleep(command.timeout as number).then(() => ({ ok: true, completed: false }));
    },
  };
}

/** Run `body` (an ES module source) in a fresh Bun process; at most 20 s. */
async function runScript(
  body: string
): Promise<{ exited: number | string; output: string; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'job-wait-exit-'));
  try {
    const script = join(dir, 'script.ts');
    writeFileSync(script, body);
    const started = Date.now();
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const exited = await Promise.race([child.exited, Bun.sleep(20_000).then(() => 'running')]);
    if (exited === 'running') child.kill(9);
    return { exited, output: await new Response(child.stdout).text(), ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const jobWait = JSON.stringify(join(import.meta.dir, '../src/client/jobWait.ts'));
const sessionModule = JSON.stringify(join(import.meta.dir, '../src/client/job-wait/session.ts'));
const schedulerModule = JSON.stringify(
  join(import.meta.dir, '../src/client/job-wait/readScheduler.ts')
);

function session(): JobWaitSession {
  return new JobWaitSession({
    reader: { read: () => Promise.resolve(null) },
    finish: () => undefined,
    scheduler: readSchedulerFor({}, 20),
  });
}

test('a settled wait issues no more holds or reads', async () => {
  const tcp = holdingTransport();
  expect(
    await waitJobUntilFinished({ tcp }, 'job-1', null, 1_500).catch((e: Error) => e.message)
  ).toBe('waitUntilFinished timed out after 1500ms');
  const sentAtSettle = tcp.sent.length;

  await Bun.sleep(2_500);

  expect(tcp.sent.length).toBe(sentAtSettle);
});

test('settling a wait ends its pending pause', async () => {
  const wait = session();
  const pause = wait.sleep(10_000);
  setTimeout(() => wait.settle({ value: 'done' }), 50);

  const started = Date.now();
  await pause;
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('a pending pause does not keep the process alive', async () => {
  const { exited, output, ms } = await runScript(
    `import { JobWaitSession } from ${sessionModule};
import { readSchedulerFor } from ${schedulerModule};
const wait = new JobWaitSession({ reader: { read: () => Promise.resolve(null) }, finish: () => {}, scheduler: readSchedulerFor({}, 20) });
void wait.sleep(15_000);
console.log('scheduled');
`
  );
  expect(exited).toBe(0);
  expect(output).toContain('scheduled');
  // Without unref the process would live for the 15 s pause.
  expect(ms).toBeLessThan(10_000);
});

test('a script waiting on a wait sees it settle at the TTL, even while a read is pending', async () => {
  // The broker double never answers: when the TTL elapses, the wait makes one more read
  // (bounded at 1 s) and must keep the process alive until it has settled. No top-level
  // await: Bun keeps a process alive for a pending top-level await, not for a callback.
  const { exited, output } = await runScript(
    `import { waitJobUntilFinished } from ${jobWait};
const tcp = { send: () => new Promise(() => {}) };
waitJobUntilFinished({ tcp }, 'job-1', null, 500)
  .catch((e) => e.message)
  .then((message) => console.log('settled', message));
`
  );
  expect(exited).toBe(0);
  expect(output).toContain('settled waitUntilFinished timed out after 500ms');
});

test('the process exits once its only wait settles', async () => {
  // WaitJob answers at once, so the wait paces itself up to each hold's end (1 s, then
  // 2 s, then 4 s); a scheduled read finds the job completed after 1.5 s, often while
  // such a pause is pending. No TTL, so no deadline timer.
  const { exited, output } = await runScript(
    `import { waitJobUntilFinished } from ${jobWait};
const started = Date.now();
const tcp = {
  send(c) {
    if (c.cmd === 'WaitJob') return Promise.resolve({ ok: true, completed: false });
    if (c.cmd === 'GetResult') return Promise.resolve({ ok: true, result: 'done' });
    const state = Date.now() - started > 1_500 ? 'completed' : 'waiting';
    return Promise.resolve({ ok: true, state });
  },
};
let settledAt = 0;
process.on('exit', () => console.log('lingered', Date.now() - settledAt));
console.log('value', await waitJobUntilFinished({ tcp }, 'job-1', null, 0));
settledAt = Date.now();
`
  );
  expect(exited).toBe(0);
  expect(output).toContain('value done');
  expect(Number(/lingered (\d+)/.exec(output)?.[1])).toBeLessThan(2_000);
});
