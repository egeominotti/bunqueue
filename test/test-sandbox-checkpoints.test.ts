import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sdkSandboxSuites } from '../scripts/sdk-sandbox-suites';
import {
  CHECKPOINT_MARKER,
  quiescentResidual,
  summarizeProcesses,
  withQuiescentCheckpoints,
} from '../scripts/test-sandbox-checkpoints';
import { writeRunReport } from '../scripts/test-sandbox-report';
import { createSuiteTelemetry, type ResourceSample } from '../scripts/test-sandbox-telemetry';

const MiB = 1024 ** 2;
const SAMPLE_GROWTH = 'memory growth signal: end minus start exceeds 128 MiB and 50%';
const QUIESCENT_GROWTH =
  'memory growth signal: quiescent end minus start (anon+shmem) exceeds 128 MiB and 50%';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function reading(phase: 'before' | 'after', fields: Record<string, unknown> = {}): string {
  const values = {
    phase,
    anonBytes: 400 * 1024,
    shmemBytes: 0,
    fileBytes: 4 * MiB,
    inactiveFileBytes: 0,
    currentBytes: 5 * MiB,
    pids: 2,
    processes: '',
    ...fields,
  };
  return `${CHECKPOINT_MARKER} ${JSON.stringify(values)}`;
}

function sample(timestamp: string, memoryUsedBytes: number): ResourceSample {
  return {
    timestamp,
    cpuPercent: 10,
    memoryUsedBytes,
    memoryLimitBytes: 4096 * MiB,
    memoryPercent: (memoryUsedBytes / (4096 * MiB)) * 100,
    pids: 57,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
  };
}

// The historical Elixir shape: the first `docker stats` sample lands in the compile
// step, the last one in the final conformance run.
const CROSS_PHASE = [
  sample('2026-10-13T07:07:15Z', 4 * MiB),
  sample('2026-10-13T07:07:31Z', 330 * MiB),
];
const FLAT = [sample('2026-10-13T07:07:15Z', 200 * MiB), sample('2026-10-13T07:07:31Z', 210 * MiB)];

async function telemetryFor(lines: string[], samples: ResourceSample[]) {
  const directory = await mkdtemp(join(tmpdir(), 'bunqueue-checkpoints-'));
  directories.push(directory);
  const logPath = join(directory, 'elixir.log');
  await Bun.write(logPath, `${lines.join('\n')}\n`);
  const telemetry = await createSuiteTelemetry({
    suite: 'elixir',
    command: ['bash', '-c', 'mix test'],
    container: 'elixir-test',
    logPath,
    startedAt: '2026-10-13T07:07:13.000Z',
    finishedAt: '2026-10-13T07:07:33.000Z',
    exitCode: 0,
    oomKilled: false,
    samples,
  });
  return { directory, telemetry };
}

describe('SDK sandbox quiescent checkpoints', () => {
  test('cross-phase samples raise no growth signal when the idle readings are flat', async () => {
    const { telemetry } = await telemetryFor(
      [reading('before'), 'Result: 109 passed', reading('after', { shmemBytes: MiB })],
      CROSS_PHASE
    );

    expect(telemetry.resources.memoryDeltaBytes).toBe(326 * MiB);
    expect(telemetry.quiescent?.retainedBytes).toBe(MiB);
    expect(telemetry.anomalies).toEqual([]);
  });

  test('reports retained memory and the processes that outlived the suite command', async () => {
    // The reading taken after `mix test` before the TestBroker fix: six orphaned brokers.
    const after = reading('after', {
      anonBytes: 141_213_696,
      shmemBytes: 1_736_704,
      fileBytes: 136_425_472,
      pids: 110,
      processes: 'bun,bun,bun,bun,bun,bun',
    });
    const { telemetry } = await telemetryFor([reading('before'), after], FLAT);

    expect(telemetry.quiescent?.survivors).toHaveLength(6);
    expect(telemetry.anomalies).toEqual([
      QUIESCENT_GROWTH,
      'processes outlived the suite command: bun x6',
    ]);
  });

  test('a surviving process is reported even when it retains almost no memory', async () => {
    const { telemetry } = await telemetryFor(
      [reading('before'), reading('after', { pids: 3, processes: 'epmd' })],
      FLAT
    );

    expect(telemetry.anomalies).toEqual(['processes outlived the suite command: epmd']);
  });

  test('reclaimable page cache is excluded from retained memory', async () => {
    // Rust leaves ~1.4 GiB of build-output page cache; `docker stats` counts the active part.
    const after = reading('after', { fileBytes: 1_465_331_712, currentBytes: 1_468_284_928 });
    const { telemetry } = await telemetryFor(
      [reading('before'), after],
      [sample('2026-10-13T07:07:15Z', 4 * MiB), sample('2026-10-13T07:07:31Z', 1_400 * MiB)]
    );

    expect(telemetry.quiescent?.retainedBytes).toBe(0);
    expect(telemetry.quiescent?.after.fileBytes).toBe(1_465_331_712);
    expect(telemetry.anomalies).toEqual([]);
  });

  test('tmpfs files left in /tmp count as retained memory', async () => {
    const { telemetry } = await telemetryFor(
      [reading('before'), reading('after', { shmemBytes: 200 * MiB })],
      FLAT
    );

    expect(telemetry.quiescent?.retainedBytes).toBe(200 * MiB);
    expect(telemetry.anomalies).toEqual([QUIESCENT_GROWTH]);
  });

  test.each([
    ['the after reading is missing (OOM kill)', [reading('before'), 'Killed']],
    ['the before reading is missing', [reading('after')]],
    ['a phase is repeated', [reading('before'), reading('before'), reading('after')]],
    ['the cgroup was unreadable', [reading('before', { anonBytes: -1 }), reading('after')]],
    ['a field is missing', [reading('before', { shmemBytes: undefined }), reading('after')]],
    ['a reading is not JSON', [reading('before'), `${CHECKPOINT_MARKER} {oops`, reading('after')]],
  ])('falls back to the sample rule when %s', async (_case, lines) => {
    const { telemetry } = await telemetryFor(lines, CROSS_PHASE);

    expect(telemetry.quiescent).toBeUndefined();
    expect(telemetry.anomalies).toEqual([SAMPLE_GROWTH]);
  });

  test('only a marker at the start of a line is a reading', () => {
    const echoed = [`echo ${reading('before')}`, `  ${reading('after')}`].join('\n');
    expect(quiescentResidual(echoed)).toBeNull();
    expect(quiescentResidual([reading('before'), reading('after')].join('\n'))).not.toBeNull();
  });

  test('outlived processes are grouped by name in a stable order', () => {
    expect(summarizeProcesses(['bun', 'epmd', 'bun', 'beam.smp'])).toBe('beam.smp, bun x2, epmd');
    expect(summarizeProcesses([])).toBe('');
  });

  test('the report lists the readings and the suite JSON keeps them', async () => {
    const { directory, telemetry } = await telemetryFor(
      [reading('before'), reading('after', { shmemBytes: MiB, fileBytes: 100 * MiB })],
      CROSS_PHASE
    );

    await writeRunReport({
      logDir: directory,
      mode: 'parallel',
      durationMs: 1000,
      suites: [telemetry],
      baselinePath: null,
    });

    const markdown = await Bun.file(join(directory, 'summary.md')).text();
    expect(markdown).toContain('## Quiescent checkpoints');
    expect(markdown).toContain(
      '| elixir | 400.0 KiB / 1.4 MiB | 1.0 MiB | 100.0 MiB | 2 / 2 | none |'
    );
    const summary = await Bun.file(join(directory, 'summary.json')).json();
    expect(summary.suites[0].quiescent.retainedBytes).toBe(MiB);
  });

  test('a report without readings has no checkpoint section', async () => {
    const { directory, telemetry } = await telemetryFor(['Result: 1 passed'], FLAT);

    await writeRunReport({
      logDir: directory,
      mode: 'parallel',
      durationMs: 1000,
      suites: [telemetry],
      baselinePath: null,
    });

    expect(telemetry).not.toHaveProperty('quiescent');
    expect(await Bun.file(join(directory, 'summary.md')).text()).not.toContain(
      'Quiescent checkpoints'
    );
  });

  test('every SDK suite runs inside the wrapper and still reports its own command', () => {
    expect(sdkSandboxSuites).toHaveLength(6);
    for (const suite of sdkSandboxSuites) {
      expect(suite.command[0]).toBe('bash');
      expect(suite.containerCommand.slice(0, 2)).toEqual(['bash', '-c']);
      expect(suite.containerCommand[3]).toBe('sandbox-checkpoint');
      expect(suite.containerCommand.slice(4)).toEqual([...suite.command]);
    }
  });

  test('the wrapper brackets the command with readings and keeps its exit code', async () => {
    const proc = Bun.spawn(withQuiescentCheckpoints(['bash', '-c', 'echo inner-output; exit 7']), {
      env: { ...process.env, BUNQUEUE_SANDBOX_SETTLE_POLLS: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const lines = stdout.trim().split('\n');

    expect(code).toBe(7);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith(`${CHECKPOINT_MARKER} {"phase":"before"`);
    expect(lines[1]).toBe('inner-output');
    expect(lines[2]).toStartWith(`${CHECKPOINT_MARKER} {"phase":"after"`);
    for (const line of [lines[0], lines[2]]) {
      // Valid JSON on every platform; values are -1 where no cgroup v2 files exist.
      expect(() => JSON.parse(line.slice(CHECKPOINT_MARKER.length + 1))).not.toThrow();
    }
  });
});
