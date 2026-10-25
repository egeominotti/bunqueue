/**
 * Runs one scenario against one system and prints one JSON result line.
 *
 *   <runtime> src/scenario.ts <system> <scenario> [json-params]
 *
 * The coordinator (this process) produces; consumers run in separate worker processes
 * (src/worker.ts) on the client cores, so producing and consuming never share an event
 * loop. Every scenario that consumes checks exact delivery: each accepted job processed
 * exactly once (or exactly `attempts` times in the retry scenario). A run that loses or
 * duplicates a job fails instead of reporting a number.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { now, payload, summarize } from './stats.ts';
import { loadSystem, type Producer, type SystemName } from './systems.ts';

const [systemName, scenario, rawParams] = process.argv.slice(2) as [SystemName, string, string?];
const params: Record<string, number> = rawParams ? JSON.parse(rawParams) : {};
const system = await loadSystem(systemName);
const queueName = `bench-${scenario}-${process.pid}-${Date.now()}`;
const CLIENT_CPUS = process.env.BENCH_CLIENT_CPUS ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── worker processes ─────────────────────────────────────────────────────

interface Child {
  proc: ChildProcess;
  completed: number;
  ready: Promise<void>;
  done: Promise<any>;
}

function startWorkers(count: number, env: Record<string, string>): Child[] {
  return Array.from({ length: count }, () => {
    const args = [...process.execArgv, new URL('./worker.ts', import.meta.url).pathname];
    const command = CLIENT_CPUS ? 'taskset' : process.execPath;
    const argv = CLIENT_CPUS ? ['-c', CLIENT_CPUS, process.execPath, ...args] : args;
    const proc = spawn(command, argv, {
      env: { ...process.env, BENCH_SYSTEM: systemName, BENCH_QUEUE: queueName, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const child = { proc, completed: 0 } as Child;
    let onReady!: () => void;
    let onDone!: (value: any) => void;
    child.ready = new Promise((r) => (onReady = r));
    child.done = new Promise((r) => (onDone = r));
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (!line.startsWith('{')) return;
      const message = JSON.parse(line);
      if (message.type === 'ready') onReady();
      else if (message.type === 'progress') child.completed = message.completed;
      else if (message.type === 'done') onDone(message);
    });
    proc.on('exit', (code) => {
      if (code) onDone({ error: `worker exited with ${code}` });
    });
    return child;
  });
}

async function stopWorkers(children: Child[]) {
  for (const c of children) c.proc.stdin!.write('stop\n');
  const results = await Promise.all(children.map((c) => c.done));
  const failure = results.find((r) => r.error);
  if (failure) throw new Error(failure.error);
  return results;
}

/** Exact delivery: every accepted job processed, none twice (or exactly `times`). */
function checkDelivery(results: any[], expected: number, times = 1) {
  const seen = new Map<string, number>();
  for (const r of results)
    r.ids.forEach((id: string, i: number) => seen.set(id, (seen.get(id) ?? 0) + r.attempts[i]));
  if (seen.size !== expected) throw new Error(`processed ${seen.size} distinct jobs, expected ${expected}`);
  for (const [id, n] of seen) if (n !== times) throw new Error(`job ${id} ran ${n} times, expected ${times}`);
}

/** Waits until the queue holds nothing waiting, active or delayed and every job ran. */
async function drained(producer: Producer, children: Child[], expected: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const done = children.reduce((n, c) => n + c.completed, 0);
    if (done >= expected) {
      const c = await producer.counts();
      if (c.waiting + c.active + c.delayed === 0) return now();
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${done}/${expected} processed`);
    await sleep(5);
  }
}

async function fill(producer: Producer, total: number, batch = 1000, options = {}) {
  for (let i = 0; i < total; i += batch) {
    const n = Math.min(batch, total - i);
    await producer.addBulk(Array.from({ length: n }, (_, k) => ({ data: payload(i + k), options })));
  }
}

// ── scenarios ────────────────────────────────────────────────────────────

const scenarios: Record<string, (p: Producer) => Promise<Record<string, unknown>>> = {
  /** One add at a time: the round-trip cost of enqueueing. */
  async 'enqueue-serial'(producer) {
    const n = params.jobs ?? 20_000;
    const lat: number[] = [];
    const t0 = now();
    for (let i = 0; i < n; i++) {
      const s = now();
      await producer.add(payload(i));
      lat.push(now() - s);
    }
    const ms = now() - t0;
    return { jobs: n, ms, opsPerSec: (n / ms) * 1000, latencyMs: summarize(lat) };
  },

  /** Many producers at once: `inflight` adds outstanding at any time. */
  async 'enqueue-concurrent'(producer) {
    const n = params.jobs ?? 200_000;
    const inflight = params.inflight ?? 64;
    const lat: number[] = [];
    let next = 0;
    const t0 = now();
    await Promise.all(
      Array.from({ length: inflight }, async () => {
        while (next < n) {
          const i = next++;
          const s = now();
          await producer.add(payload(i));
          lat.push(now() - s);
        }
      })
    );
    const ms = now() - t0;
    return { jobs: n, inflight, ms, opsPerSec: (n / ms) * 1000, latencyMs: summarize(lat) };
  },

  /** addBulk in batches of `batch`. */
  async 'enqueue-bulk'(producer) {
    const n = params.jobs ?? 500_000;
    const batch = params.batch ?? 100;
    const lat: number[] = [];
    const t0 = now();
    for (let i = 0; i < n; i += batch) {
      const items = Array.from({ length: Math.min(batch, n - i) }, (_, k) => ({ data: payload(i + k) }));
      const s = now();
      await producer.addBulk(items);
      lat.push(now() - s);
    }
    const ms = now() - t0;
    return { jobs: n, batch, ms, opsPerSec: (n / ms) * 1000, batchLatencyMs: summarize(lat) };
  },

  /** Prefilled backlog, then `processes` workers x `concurrency` drain it. */
  async drain(producer) {
    const n = params.jobs ?? 200_000;
    const processes = params.processes ?? 1;
    const concurrency = params.concurrency ?? 50;
    await fill(producer, n);
    const children = startWorkers(processes, { BENCH_KIND: 'drain', BENCH_CONCURRENCY: String(concurrency) });
    await Promise.all(children.map((c) => c.ready));
    const t0 = now();
    for (const c of children) c.proc.stdin!.write('go\n');
    const end = await drained(producer, children, n, 300_000);
    const results = await stopWorkers(children);
    checkDelivery(results, n);
    const ms = end - t0;
    return { jobs: n, processes, concurrency, ms, jobsPerSec: (n / ms) * 1000 };
  },

  /** Open-loop producer at `rate` jobs/s for `seconds`; pickup latency is measured from
   *  each job's scheduled send time, so a producer or broker that falls behind shows
   *  up as latency instead of silently lowering the offered load. */
  async latency(producer) {
    const rate = params.rate ?? 5_000;
    const seconds = params.seconds ?? 15;
    const processes = params.processes ?? 2;
    const concurrency = params.concurrency ?? 50;
    const total = rate * seconds;
    const children = startWorkers(processes, { BENCH_KIND: 'latency', BENCH_CONCURRENCY: String(concurrency) });
    await Promise.all(children.map((c) => c.ready));
    for (const c of children) c.proc.stdin!.write('go\n');
    await sleep(500);
    const t0 = now();
    let sent = 0;
    let outstanding = 0;
    const pending: Promise<unknown>[] = [];
    while (sent < total) {
      const due = Math.min(total, Math.floor(((now() - t0) * rate) / 1000) + 1);
      while (sent < due && outstanding < 512) {
        const i = sent++;
        outstanding++;
        pending.push(producer.add({ ...payload(i), t: t0 + (i * 1000) / rate }).finally(() => outstanding--));
      }
      await sleep(1);
    }
    await Promise.all(pending);
    const sendMs = now() - t0;
    await drained(producer, children, total, 120_000);
    const results = await stopWorkers(children);
    checkDelivery(results, total);
    return {
      rate,
      seconds,
      processes,
      concurrency,
      offered: total,
      achievedSendRate: (total / sendMs) * 1000,
      pickupLatencyMs: summarize(results.flatMap((r) => r.samples)),
    };
  },

  /** Delayed jobs due 1-4 s after they are added: how late do they start? */
  async delayed(producer) {
    const n = params.jobs ?? 20_000;
    const children = startWorkers(1, { BENCH_KIND: 'delayed', BENCH_CONCURRENCY: '50' });
    await Promise.all(children.map((c) => c.ready));
    for (const c of children) c.proc.stdin!.write('go\n');
    for (let i = 0; i < n; i += 1000) {
      const at = now();
      await producer.addBulk(
        Array.from({ length: Math.min(1000, n - i) }, (_, k) => {
          const delay = 1000 + ((i + k) % 3000);
          return { data: { ...payload(i + k), due: at + delay }, options: { delay } };
        })
      );
    }
    await drained(producer, children, n, 120_000);
    const results = await stopWorkers(children);
    checkDelivery(results, n);
    return { jobs: n, latenessMs: summarize(results.flatMap((r) => r.samples)) };
  },

  /** Every job fails twice and succeeds on its third attempt (attempts: 3, no backoff). */
  async retry(producer) {
    const n = params.jobs ?? 20_000;
    await fill(producer, n, 1000, { attempts: 3, backoff: 0 });
    const children = startWorkers(1, { BENCH_KIND: 'retry', BENCH_CONCURRENCY: '50', BENCH_SUCCEED_ON_ATTEMPT: '3' });
    await Promise.all(children.map((c) => c.ready));
    const t0 = now();
    for (const c of children) c.proc.stdin!.write('go\n');
    const end = await drained(producer, children, n, 300_000);
    const results = await stopWorkers(children);
    checkDelivery(results, n, 3);
    const ms = end - t0;
    return { jobs: n, attemptsPerJob: 3, ms, jobsPerSec: (n / ms) * 1000, attemptsPerSec: ((3 * n) / ms) * 1000 };
  },

  /** Fill a backlog and leave it in place; the orchestrator reads the broker's memory. */
  async fill(producer) {
    const n = params.jobs ?? 1_000_000;
    const t0 = now();
    await fill(producer, n);
    const c = await producer.counts();
    if (c.waiting !== n) throw new Error(`backlog holds ${c.waiting}, expected ${n}`);
    return { jobs: n, ms: now() - t0, keep: true };
  },
};

const run = scenarios[scenario];
if (!run) throw new Error(`unknown scenario ${scenario}`);
const producer = await system.producer(queueName);
let result: Record<string, unknown>;
try {
  result = await run(producer);
} finally {
  if (scenario !== 'fill') await producer.obliterate().catch(() => undefined);
  await producer.close().catch(() => undefined);
}
process.stdout.write(`RESULT ${JSON.stringify({ system: systemName, scenario, params, queue: queueName, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, ...result })}\n`);
process.exit(0);
