/**
 * Regression: `TcpClient.close()` installs a process-wide `unhandledRejection`
 * filter so synthetic `ClientClosedError` rejections leaking through derived
 * promise chains do not crash the host on shutdown. The original filter did
 * nothing for any other reason, but the mere presence of a listener disables
 * the runtime default (print + exit 1), so after the first client close every
 * unhandled rejection of the host application was silently swallowed.
 *
 * Each scenario runs in a child process: Bun's test runner treats in-process
 * unhandled rejections as failures, and the behavior under test is the
 * runtime's process-level default. A crash is asserted through the exit status
 * and stderr only: Bun prints a timer-originated rejection at once but may exit
 * on the next event-loop wakeup, even with no listener installed at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clientPath = join(import.meta.dir, '..', 'src', 'client', 'tcp', 'client.ts');
const errorsPath = join(import.meta.dir, '..', 'src', 'client', 'tcp', 'errors.ts');
const CHILD_TIMEOUT_MS = 10_000;

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bunqueue-closed-filter-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function runChild(name: string, source: string, flags: string[] = []): Promise<ChildResult> {
  const file = join(workDir, `${name}.ts`);
  writeFileSync(file, source);
  const child = Bun.spawn([process.execPath, ...flags, file], {
    cwd: workDir,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

function describeChild(result: ChildResult): string {
  return `exit=${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

const importClient = `import { ClientClosedError, TcpClient } from ${JSON.stringify(clientPath)};`;
const closeClient = 'new TcpClient({ autoReconnect: false }).close();';
const listenerCount = "process.listenerCount('unhandledRejection')";

describe('ClientClosedError filter does not swallow application rejections', () => {
  test('an application rejection after close() still crashes with the runtime default', async () => {
    const result = await runChild(
      'app-rejection',
      `${importClient}
void ClientClosedError;
${closeClient}
console.log('listeners=' + ${listenerCount});
Promise.reject(new Error('app bug'));
`
    );
    const details = describeChild(result);
    expect(result.stdout, details).toContain('listeners=1');
    expect(result.stderr, details).toContain('app bug');
    expect(result.exitCode, details).not.toBe(0);
  }, 15_000);

  test('a foreign error named ClientClosedError (e.g. undici) is not swallowed', async () => {
    const result = await runChild(
      'foreign-name',
      `${importClient}
void ClientClosedError;
${closeClient}
const foreign = new Error('foreign client closed');
foreign.name = 'ClientClosedError';
Promise.reject(foreign);
`
    );
    const details = describeChild(result);
    expect(result.stderr, details).toContain('foreign client closed');
    expect(result.exitCode, details).not.toBe(0);
  }, 15_000);

  test('a derived chain rejecting with ClientClosedError after close() is still swallowed', async () => {
    const result = await runChild(
      'derived-chain',
      `${importClient}
const server = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: { open() {}, data() {} },
});
const client = new TcpClient({ host: '127.0.0.1', port: server.port, autoReconnect: false });
await client.connect();
// Derived promise without a handler: rejectAll only silences the tracked promise.
const derived = client.send({ cmd: 'Ping' }).then((response) => response);
await Bun.sleep(20);
client.close();
setTimeout(() => {
  derived.then(
    () => console.log('derived-resolved'),
    (error) => console.log('derived-closed=' + (error instanceof ClientClosedError))
  );
  setTimeout(() => {
    console.log('timer-ran listeners=' + ${listenerCount});
    server.stop(true);
  }, 50);
}, 200);
`
    );
    const details = describeChild(result);
    expect(result.stdout, details).toContain('derived-closed=true');
    expect(result.stdout, details).toContain('timer-ran listeners=1');
    expect(result.stderr, details).not.toContain('Client closed');
    expect(result.exitCode, details).toBe(0);
  }, 15_000);

  for (const order of ['before', 'after'] as const) {
    test(`an application listener registered ${order} close() owns the rejection`, async () => {
      const appListener = `const seen = [];
process.on('unhandledRejection', (reason) => {
  seen.push(reason instanceof ClientClosedError ? 'closed' : String(reason?.message ?? reason));
});`;
      const result = await runChild(
        `app-listener-${order}`,
        `${importClient}
${order === 'before' ? appListener : ''}
${closeClient}
${order === 'after' ? appListener : ''}
Promise.reject(new Error('app bug'));
setTimeout(() => {
  console.log('seen=' + JSON.stringify(seen));
  console.log('listeners=' + ${listenerCount});
}, 300);
`
      );
      const details = describeChild(result);
      // Delivered exactly once: bunqueue must not re-raise what the app handles.
      expect(result.stdout, details).toContain('seen=["app bug"]');
      expect(result.stdout, details).toContain('listeners=2');
      expect(result.exitCode, details).toBe(0);
    }, 15_000);
  }

  test('the filter steps aside for an unowned rejection and a later close() re-installs it', async () => {
    // warn mode keeps the process alive after the re-raised rejection.
    const result = await runChild(
      'reinstall',
      `${importClient}
void ClientClosedError;
${closeClient}
console.log('installed=' + ${listenerCount});
Promise.reject(new Error('app bug'));
setTimeout(() => {
  console.log('after-app-rejection=' + ${listenerCount});
  ${closeClient}
  console.log('reinstalled=' + ${listenerCount});
  ${closeClient}
  console.log('idempotent=' + ${listenerCount});
}, 300);
`,
      ['--unhandled-rejections=warn']
    );
    const details = describeChild(result);
    expect(result.stdout, details).toContain('installed=1');
    expect(result.stdout, details).toContain('after-app-rejection=0');
    expect(result.stdout, details).toContain('reinstalled=1');
    expect(result.stdout, details).toContain('idempotent=1');
    expect(result.stderr, details).toContain('app bug');
    expect(result.exitCode, details).toBe(0);
  }, 15_000);

  test('duplicate module copies share one filter and still surface application rejections', async () => {
    // Two bunqueue copies in one process (dual package, two installed versions).
    const result = await runChild(
      'duplicate-copies',
      `import * as a from ${JSON.stringify(`${errorsPath}?copy=a`)};
import * as b from ${JSON.stringify(`${errorsPath}?copy=b`)};
console.log('distinct=' + (a.ClientClosedError !== b.ClientClosedError));
a.installClientClosedFilter();
b.installClientClosedFilter();
console.log('listeners=' + ${listenerCount});
Promise.reject(new a.ClientClosedError());
Promise.reject(new b.ClientClosedError());
setTimeout(() => {
  console.log('closed-errors-swallowed');
  Promise.reject(new Error('app bug'));
}, 200);
`
    );
    const details = describeChild(result);
    expect(result.stdout, details).toContain('distinct=true');
    expect(result.stdout, details).toContain('listeners=1');
    expect(result.stdout, details).toContain('closed-errors-swallowed');
    expect(result.stderr, details).not.toContain('Client closed');
    expect(result.stderr, details).toContain('app bug');
    expect(result.exitCode, details).not.toBe(0);
  }, 15_000);
});
