/**
 * Repro: color output did not follow one policy, and none of them followed
 * no-color.org.
 *
 * - CLI result output (`src/cli/output/style.ts`) disabled color only for the exact
 *   value `NO_COLOR=1`: `NO_COLOR=true` (or `yes`, any non-empty value) still colored,
 *   `FORCE_COLOR` was ignored, and `TERM=dumb` was not considered.
 * - `bunqueue --help`, `bunqueue doctor` and the server startup banner always wrote
 *   ANSI escapes, even with NO_COLOR set and when stdout is a pipe or a log file.
 *
 * Now every surface asks one function: FORCE_COLOR (non-empty; `0`/`false` force it
 * off) wins, then NO_COLOR (any non-empty value) or TERM=dumb disable, otherwise color
 * only on a TTY.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { freePort, makeSandbox, REPO, runChild, runServer } from './config-test-support';

const box = makeSandbox('bunqueue-color-');
afterAll(() => box.cleanup());

const ANSI = /\x1b\[[0-9;]*m/;

const STYLE_PROBE = box.writeFile(
  'style-probe.ts',
  `
const tty = process.env.PROBE_TTY === '1';
Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
const { color, colors } = await import(${JSON.stringify(join(REPO, 'src/cli/output/style.ts'))});
console.log(JSON.stringify({ colored: color('x', colors.red) !== 'x' }));
`
);

async function cliColored(tty: boolean, vars: Record<string, string>): Promise<unknown> {
  const run = await runChild([STYLE_PROBE], {
    cwd: box.dir,
    env: { PROBE_TTY: tty ? '1' : '0', ...vars },
    killAfterMs: 10_000,
  });
  const line = run.output.split('\n').find((item) => item.startsWith('{'));
  return line ? (JSON.parse(line) as { colored: boolean }).colored : run.output;
}

describe('CLI result output (style.ts)', () => {
  test.each([
    ['a TTY, no env', true, {}, true],
    ['a pipe, no env', false, {}, false],
    ['NO_COLOR=1', true, { NO_COLOR: '1' }, false],
    ['NO_COLOR=true', true, { NO_COLOR: 'true' }, false],
    ['NO_COLOR=yes', true, { NO_COLOR: 'yes' }, false],
    ['NO_COLOR=0 (any non-empty value)', true, { NO_COLOR: '0' }, false],
    ['NO_COLOR= (empty means unset)', true, { NO_COLOR: '' }, true],
    ['TERM=dumb', true, { TERM: 'dumb' }, false],
    ['FORCE_COLOR=1 on a pipe', false, { FORCE_COLOR: '1' }, true],
    ['FORCE_COLOR=true beats NO_COLOR', false, { FORCE_COLOR: 'true', NO_COLOR: '1' }, true],
    ['FORCE_COLOR=0 on a TTY', true, { FORCE_COLOR: '0' }, false],
    ['FORCE_COLOR=false on a TTY', true, { FORCE_COLOR: 'false' }, false],
  ] as const)(
    '%s',
    async (_label, tty, vars, expected) => {
      expect(await cliColored(tty, vars)).toBe(expected);
    },
    15_000
  );
});

/** The banner's last line ("Shards … logical CPUs") followed by its closing rule. */
const BANNER_END = /logical CPUs[\s\S]*?─{20}/;

describe('help, doctor and the server banner follow the same policy', () => {
  let bannerRuns = 0;
  const surfaces = {
    help: (vars: Record<string, string>) =>
      runChild([join(REPO, 'src/cli/index.ts'), '--help'], {
        cwd: box.dir,
        env: vars,
        killAfterMs: 10_000,
      }),
    doctor: (vars: Record<string, string>) =>
      runChild([join(REPO, 'src/cli/index.ts'), 'doctor', '--port', String(freePort())], {
        cwd: box.dir,
        env: vars,
        killAfterMs: 10_000,
      }),
    // Each banner run gets its own database (the three start at once) and is killed
    // once the banner's closing rule is written, not after a fixed delay that a loaded
    // host can outrun before the banner appears.
    banner: (vars: Record<string, string>) => {
      bannerRuns++;
      return runServer(box, {
        env: {
          STATS_INTERVAL_MS: '600000',
          BUNQUEUE_DATA_PATH: join(box.dir, `banner-${bannerRuns}.db`),
          ...vars,
        },
        killAfterMs: 15_000,
        killWhen: BANNER_END,
      });
    },
  };

  test.each(Object.keys(surfaces) as Array<keyof typeof surfaces>)(
    '%s: no ANSI on a pipe or with NO_COLOR, ANSI with FORCE_COLOR',
    async (surface) => {
      const [pipe, noColor, forced] = await Promise.all([
        surfaces[surface]({}),
        surfaces[surface]({ NO_COLOR: 'true' }),
        surfaces[surface]({ FORCE_COLOR: '1' }),
      ]);
      expect({
        pipe: ANSI.test(pipe.output),
        noColor: ANSI.test(noColor.output),
        forced: ANSI.test(forced.output),
      }).toEqual({ pipe: false, noColor: false, forced: true });
      // The text itself is unchanged.
      expect(Bun.stripANSI(forced.output).length).toBeGreaterThan(0);
    },
    20_000
  );
});
