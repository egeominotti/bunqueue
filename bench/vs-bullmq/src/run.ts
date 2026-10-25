/**
 * Orchestrates the full bunqueue vs BullMQ/Redis benchmark.
 *
 *   bun src/run.ts [--quick]
 *
 * For each storage mode (memory, durable) it starts one broker at a time, pinned to
 * the same two physical cores (BROKER_CPUS): Redis from the official image with host
 * networking, or the bunqueue server from the pinned npm package. Clients run pinned
 * to the other CCD (CLIENT_CPUS). Every scenario/configuration runs once as warm-up
 * and REPS times measured, each in a fresh client process; raw results go to
 * results/<stamp>/raw.jsonl, medians to summary.json and the tables to report.md.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { median } from './stats.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const QUICK = process.argv.includes('--quick');
const REPS = QUICK ? 1 : 5;
const BROKER_CPUS = '2,3,18,19';
const CLIENT_CPUS = '8-15,24-31';
const REDIS_PORT = 6400;
const BUNQUEUE_PORT = 6789;
const DATA = '/var/tmp/bqbench';
const REDIS_IMAGE = 'redis:8.10.2';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(ROOT, 'results', QUICK ? `quick-${stamp}` : stamp);
mkdirSync(OUT, { recursive: true });

type Mode = 'memory' | 'durable';
interface Config {
  id: string;
  label: string;
  system: 'bunqueue' | 'bullmq';
  runtime: 'bun' | 'node';
  workerOptions?: Record<string, unknown>;
  /** Run the enqueue scenarios too (they do not depend on worker options). */
  enqueue: boolean;
}

const CONFIGS: Config[] = [
  { id: 'bunqueue', label: 'bunqueue 2.9.20 (defaults)', system: 'bunqueue', runtime: 'bun', enqueue: true },
  { id: 'bunqueue-longpoll', label: 'bunqueue 2.9.20 (pollTimeout: 5000)', system: 'bunqueue', runtime: 'bun', workerOptions: { pollTimeout: 5000 }, enqueue: false },
  { id: 'bullmq-node', label: 'BullMQ 6.4.2 on Node.js', system: 'bullmq', runtime: 'node', enqueue: true },
  { id: 'bullmq-bun', label: 'BullMQ 6.4.2 on Bun', system: 'bullmq', runtime: 'bun', enqueue: true },
];

const scale = (n: number) => (QUICK ? Math.max(1000, Math.round(n / 20)) : n);
const SCENARIOS: { id: string; scenario: string; params: Record<string, number>; enqueue?: boolean }[] = [
  { id: 'enqueue-serial', scenario: 'enqueue-serial', params: { jobs: scale(20_000) }, enqueue: true },
  { id: 'enqueue-concurrent', scenario: 'enqueue-concurrent', params: { jobs: scale(200_000), inflight: 64 }, enqueue: true },
  { id: 'enqueue-bulk', scenario: 'enqueue-bulk', params: { jobs: scale(500_000), batch: 100 }, enqueue: true },
  { id: 'drain-1x50', scenario: 'drain', params: { jobs: scale(100_000), processes: 1, concurrency: 50 } },
  { id: 'drain-4x50', scenario: 'drain', params: { jobs: scale(200_000), processes: 4, concurrency: 50 } },
  { id: 'drain-8x50', scenario: 'drain', params: { jobs: scale(200_000), processes: 8, concurrency: 50 } },
  { id: 'latency-1k', scenario: 'latency', params: { rate: 1_000, seconds: QUICK ? 3 : 15, processes: 2, concurrency: 50 } },
  { id: 'latency-5k', scenario: 'latency', params: { rate: 5_000, seconds: QUICK ? 3 : 15, processes: 2, concurrency: 50 } },
  { id: 'latency-10k', scenario: 'latency', params: { rate: 10_000, seconds: QUICK ? 3 : 15, processes: 2, concurrency: 50 } },
  { id: 'delayed', scenario: 'delayed', params: { jobs: scale(20_000) } },
  { id: 'retry', scenario: 'retry', params: { jobs: scale(20_000) } },
];

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => {
  console.log(line);
  appendFileSync(join(OUT, 'run.log'), `${line}\n`);
};

// ── brokers ──────────────────────────────────────────────────────────────

let bunqueueServer: ReturnType<typeof spawn> | null = null;

function portOpen(port: number): boolean {
  return sh('bash', ['-c', `ss -ltn | grep -q ":${port} "`]).status === 0;
}

async function waitPort(port: number, open = true) {
  for (let i = 0; i < 100; i++) {
    if (portOpen(port) === open) return;
    await sleep(100);
  }
  throw new Error(`port ${port} did not ${open ? 'open' : 'close'}`);
}

async function startBroker(system: 'bunqueue' | 'bullmq', mode: Mode) {
  await stopBrokers();
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(join(DATA, 'redis'), { recursive: true });
  if (system === 'bullmq') {
    const persistence =
      mode === 'memory' ? ['--save', '', '--appendonly', 'no'] : ['--save', '', '--appendonly', 'yes', '--appendfsync', 'everysec'];
    const r = sh('docker', [
      'run', '-d', '--name', 'bqbench-redis', '--network', 'host', '--cpuset-cpus', BROKER_CPUS,
      '-v', `${DATA}/redis:/data`, REDIS_IMAGE, 'redis-server', '--port', String(REDIS_PORT), '--dir', '/data', ...persistence,
    ]);
    if (r.status !== 0) throw new Error(`redis: ${r.stderr}`);
    await waitPort(REDIS_PORT);
  } else {
    const args = ['-c', BROKER_CPUS, 'bun', join(ROOT, 'node_modules/bunqueue/dist/cli/index.js'), 'start', '--host', '127.0.0.1'];
    if (mode === 'durable') args.push('--data-path', `${DATA}/bunqueue.db`);
    const env = { ...process.env, RATE_LIMIT_WINDOW_MS: '0' };
    delete (env as any).DATA_PATH;
    delete (env as any).BUNQUEUE_DATA_PATH;
    bunqueueServer = spawn('taskset', args, { env, stdio: ['ignore', 'ignore', 'inherit'] });
    await waitPort(BUNQUEUE_PORT);
  }
  await sleep(500);
}

async function stopBrokers() {
  sh('docker', ['rm', '-f', 'bqbench-redis']);
  if (bunqueueServer) {
    bunqueueServer.kill('SIGTERM');
    bunqueueServer = null;
  }
  const pid = sh('bash', ['-c', `ss -ltnp | grep ":${BUNQUEUE_PORT} " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2`]).stdout.trim();
  if (pid) process.kill(Number(pid), 'SIGTERM');
  await waitPort(BUNQUEUE_PORT, false).catch(() => undefined);
  await waitPort(REDIS_PORT, false).catch(() => undefined);
}

/** Resident memory of the broker, in MiB. */
function brokerRssMiB(system: 'bunqueue' | 'bullmq'): number {
  if (system === 'bullmq') {
    const info = sh('docker', ['exec', 'bqbench-redis', 'redis-cli', '-p', String(REDIS_PORT), 'INFO', 'memory']).stdout;
    const bytes = Number(/used_memory_rss:(\d+)/.exec(info)?.[1] ?? NaN);
    return bytes / 1024 / 1024;
  }
  const pid = sh('bash', ['-c', `ss -ltnp | grep ":${BUNQUEUE_PORT} " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2`]).stdout.trim();
  const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? NaN);
  return kb / 1024;
}

// ── scenario runs ────────────────────────────────────────────────────────

function runScenario(config: Config, scenario: string, params: Record<string, number>): Record<string, any> {
  const runtime = config.runtime === 'node' ? 'node' : 'bun';
  const r = sh('taskset', ['-c', CLIENT_CPUS, runtime, join(ROOT, 'src/scenario.ts'), config.system, scenario, JSON.stringify(params)], );
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`${config.id} ${scenario} failed (exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`);
  return JSON.parse(line.slice(7));
}

function headline(result: Record<string, any>): number {
  return result.opsPerSec ?? result.jobsPerSec ?? result.pickupLatencyMs?.p50 ?? result.latenessMs?.p50 ?? NaN;
}

async function main() {
  const env = {
    date: new Date().toISOString(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    kernel: sh('uname', ['-sr']).stdout.trim(),
    os: /PRETTY_NAME="([^"]+)"/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1],
    governor: existsSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor')
      ? readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim()
      : 'unknown',
    bun: sh('bun', ['--version']).stdout.trim(),
    node: sh('node', ['--version']).stdout.trim(),
    docker: sh('docker', ['--version']).stdout.trim(),
    redis: REDIS_IMAGE,
    packages: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies,
    installed: Object.fromEntries(
      ['bullmq', 'bunqueue', 'ioredis'].map((p) => [p, JSON.parse(readFileSync(join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version])
    ),
    brokerCpus: BROKER_CPUS,
    clientCpus: CLIENT_CPUS,
    reps: REPS,
  };
  writeFileSync(join(OUT, 'environment.json'), `${JSON.stringify(env, null, 2)}\n`);
  log(`benchmark ${stamp}: ${JSON.stringify(env)}`);

  const summary: any[] = [];
  for (const mode of ['memory', 'durable'] as Mode[]) {
    for (const system of ['bunqueue', 'bullmq'] as const) {
      const configs = CONFIGS.filter((c) => c.system === system);
      await startBroker(system, mode);
      for (const s of SCENARIOS) {
        for (const config of configs) {
          if (s.enqueue && !config.enqueue) continue;
          process.env.BENCH_WORKER_OPTIONS = JSON.stringify(config.workerOptions ?? {});
          process.env.BENCH_REDIS_PORT = String(REDIS_PORT);
          process.env.BENCH_BUNQUEUE_PORT = String(BUNQUEUE_PORT);
          process.env.BENCH_CLIENT_CPUS = CLIENT_CPUS;
          const runs: any[] = [];
          for (let rep = 0; rep <= REPS; rep++) {
            const result = runScenario(config, s.scenario, s.params);
            const record = { mode, config: config.id, label: config.label, id: s.id, rep, warmup: rep === 0, ...result };
            appendFileSync(join(OUT, 'raw.jsonl'), `${JSON.stringify(record)}\n`);
            if (rep > 0) runs.push(result);
          }
          const values = runs.map(headline);
          const entry = { mode, config: config.id, label: config.label, id: s.id, median: median(values), min: Math.min(...values), max: Math.max(...values), runs };
          summary.push(entry);
          log(`${mode} ${s.id} ${config.id}: median ${entry.median.toFixed(2)} [${entry.min.toFixed(2)}–${entry.max.toFixed(2)}]`);
        }
      }
      // Broker memory with a 1M-job backlog, on a fresh broker.
      await startBroker(system, mode);
      const config = configs[0];
      process.env.BENCH_WORKER_OPTIONS = '{}';
      const before = brokerRssMiB(system);
      const fill = runScenario(config, 'fill', { jobs: QUICK ? 50_000 : 1_000_000 });
      await sleep(2000);
      const after = brokerRssMiB(system);
      const entry = { mode, config: config.id, label: config.label, id: 'memory-1m', idleMiB: before, backlogMiB: after, perMillionMiB: (after - before) / (fill.jobs / 1_000_000), fillMs: fill.ms };
      summary.push(entry);
      appendFileSync(join(OUT, 'raw.jsonl'), `${JSON.stringify(entry)}\n`);
      log(`${mode} memory ${system}: idle ${before.toFixed(1)} MiB, with ${fill.jobs} jobs ${after.toFixed(1)} MiB`);
    }
  }
  await stopBrokers();
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ environment: env, results: summary }, null, 2)}\n`);
  log(`done: ${OUT}`);
}

main().catch(async (error) => {
  log(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  await stopBrokers();
  process.exit(1);
});
