import { expect, setDefaultTimeout, test } from 'bun:test';

// Repro: the MCP TCP backend sized its pool with `Number(BUNQUEUE_POOL_SIZE) || 2`.
// "Infinity" made the pool constructor loop until the process ran out of memory, "1e3"
// opened 1000 connections, "1.5" two, "-3" one, and a typo ("abc", "0") silently
// became 2. It is now parsed with the shared parseIntegerEnv (src/mcp/backend/tcp/env.ts),
// still with `Number()` syntax for upgrade compatibility (`1e3` is 1000, `0x10` is 16):
// an infinite value or one above 65535 (the pool ceiling) stops startup naming the
// variable; a value that is not a whole number >= 1 keeps 2, now with a warning.

setDefaultTimeout(30_000);

const BASE = `${import.meta.dir}/../src/mcp/backend/tcp`;

/** Build a TcpBackend in a fresh process with BUNQUEUE_POOL_SIZE = `value`. */
async function backendWith(value: string | undefined): Promise<string> {
  const script = `
    const { TcpBackend } = await import(${JSON.stringify(BASE)});
    try {
      const backend = new TcpBackend({ host: '127.0.0.1', port: 1 });
      console.log('pool of ' + backend.pool.getPoolSize());
      backend.shutdown();
    } catch (error) {
      console.log(error.name + ': ' + error.message);
    }
    process.exit(0);
  `;
  const env = { ...process.env, BUNQUEUE_POOL_SIZE: value };
  if (value === undefined) delete env.BUNQUEUE_POOL_SIZE;
  const child = Bun.spawn([process.execPath, '-e', script], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => 'hung')]);
  if (exited === 'hung') {
    child.kill(9);
    return 'hung';
  }
  return (await new Response(child.stdout).text()).trim();
}

test.each(['Infinity', '-Infinity', '65536', '9007199254740993'])(
  'BUNQUEUE_POOL_SIZE=%p stops startup with an error naming the variable',
  async (value) => {
    expect(await backendWith(value)).toBe(
      `Error: Invalid BUNQUEUE_POOL_SIZE: ${JSON.stringify(value)} (expected a whole number between 1 and 65535)`
    );
  }
);

test.each<[string | undefined, string]>([
  [undefined, 'pool of 2'],
  ['', 'pool of 2'],
  ['1', 'pool of 1'],
  [' 4 ', 'pool of 4'],
  ['16', 'pool of 16'],
  ['0016', 'pool of 16'],
  ['1e1', 'pool of 10'],
  ['0x10', 'pool of 16'],
  // Not a whole number >= 1: the 2.9.10 fallback, with a warning on stderr.
  ['abc', 'pool of 2'],
  ['0', 'pool of 2'],
  ['-3', 'pool of 2'],
  ['1.5', 'pool of 2'],
  ['   ', 'pool of 2'],
])('BUNQUEUE_POOL_SIZE=%p gives a %s', async (value, expected) => {
  expect(await backendWith(value)).toBe(expected);
});
