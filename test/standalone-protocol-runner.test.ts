import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('standalone MCP verification correctly accepts expected negatives and checks ignored mutations', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      'scripts/test-mcp-all.ts',
      '-t',
      'keeps legacy text|an empty retry ID|must not claim an expired execution',
    ],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0 });
    expect(stdout + stderr).toMatch(/Ran [1-9]\d* tests across/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 65_000);
