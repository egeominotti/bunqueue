import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const alias of ['DATA_PATH', 'BUNQUEUE_DATA_PATH', 'BQ_DATA_PATH', 'SQLITE_PATH']) {
  test(`standalone protocol tests do not open a caller database from ${alias}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bq-runner-caller-'));
    const database = join(dir, 'caller.db');
    const env = { ...process.env };
    for (const key of ['DATA_PATH', 'BUNQUEUE_DATA_PATH', 'BQ_DATA_PATH', 'SQLITE_PATH']) {
      delete env[key];
    }
    env[alias] = database;
    const child = Bun.spawn(
      [process.execPath, 'scripts/test-mcp-all.ts', '-t', 'keeps legacy text'],
      {
        cwd: join(import.meta.dir, '..'),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0 });
      expect(existsSync(database)).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
}

test('standalone protocol descendants do not reload caller persistence from a dotenv file', async () => {
  const root = join(import.meta.dir, '..');
  const fixture = mkdtempSync(join(tmpdir(), 'bq-runner-dotenv-'));
  const database = join(fixture, 'caller.db');
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'test'));
  copyFileSync(join(root, 'scripts/test-mcp-all.ts'), join(fixture, 'scripts/test-mcp-all.ts'));
  copyFileSync(
    join(root, 'test/mcp-http-transport.test.ts'),
    join(fixture, 'test/mcp-http-transport.test.ts')
  );
  symlinkSync(join(root, 'src'), join(fixture, 'src'), 'dir');
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  writeFileSync(
    join(fixture, '.env'),
    [
      `DATA_PATH=${database}`,
      'BUNQUEUE_CLOUD_URL=http://127.0.0.1:1',
      'BUNQUEUE_CLOUD_API_KEY=dummy',
      'BUNQUEUE_CLOUD_INSTANCE_ID=review',
      'BUNQUEUE_CLOUD_USE_HTTP=false',
      'BUNQUEUE_CLOUD_USE_WEBSOCKET=false',
    ].join('\n')
  );
  const child = Bun.spawn(
    [process.execPath, 'scripts/test-mcp-all.ts', '-t', 'stdio stays the default'],
    { cwd: fixture, stdout: 'pipe', stderr: 'pipe' }
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0 });
    expect(stdout + stderr).toMatch(/1 pass/);
    expect(existsSync(database)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(fixture, { recursive: true, force: true });
  }
}, 25_000);

test('standalone protocol doctor descendants ignore caller broker settings from dotenv', async () => {
  const root = join(import.meta.dir, '..');
  const fixture = mkdtempSync(join(tmpdir(), 'bq-runner-doctor-dotenv-'));
  let connections = 0;
  const sentinel = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections++;
        socket.end();
      },
      data() {
        // The sentinel only counts connections; it never processes application data.
      },
    },
  });
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'test'));
  copyFileSync(join(root, 'scripts/test-mcp-all.ts'), join(fixture, 'scripts/test-mcp-all.ts'));
  copyFileSync(join(root, 'test/mcp-doctor.test.ts'), join(fixture, 'test/mcp-doctor.test.ts'));
  symlinkSync(join(root, 'src'), join(fixture, 'src'), 'dir');
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  writeFileSync(
    join(fixture, '.env'),
    ['BUNQUEUE_MODE=tcp', 'BUNQUEUE_HOST=127.0.0.1', `BUNQUEUE_PORT=${sentinel.port}`].join('\n')
  );
  const child = Bun.spawn(
    [
      process.execPath,
      'scripts/test-mcp-all.ts',
      '-t',
      'doctor recognizes an existing workflow store',
    ],
    { cwd: fixture, stdout: 'pipe', stderr: 'pipe' }
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, connections, output: stdout + stderr }).toMatchObject({
      exitCode: 0,
      connections: 0,
    });
    expect(stdout + stderr).toMatch(/1 pass/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
    sentinel.stop(true);
    rmSync(fixture, { recursive: true, force: true });
  }
}, 25_000);
