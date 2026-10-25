/**
 * Exports a run's summary into the docs site's data file
 * (docs/src/data/benchmark-vs-bullmq.json), read by the homepage benchmark section
 * and the full benchmark page.
 *
 *   bun src/export.ts results/<stamp>
 *
 * For each metric bunqueue is shown with its defaults, except pickup latency and
 * delayed-job lateness, which use `pollTimeout: 5000` (long polling, the mode BullMQ
 * workers use by default). BullMQ is shown on whichever runtime (Node.js or Bun) did
 * better for that metric, so every ratio is computed against BullMQ's best result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: bun src/export.ts results/<stamp>');
const { environment, results } = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));

type Metric = {
  id: string;
  key: string;
  title: string;
  unit: 'jobs/s' | 'ms';
  higherIsBetter: boolean;
  longPoll?: boolean;
  pick: (run: any) => number;
};

const METRICS: Metric[] = [
  { id: 'enqueue-serial', key: 'add-serial', title: 'Add jobs one at a time', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'enqueue-concurrent', key: 'add-concurrent', title: 'Add jobs, 64 in flight', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'enqueue-bulk', key: 'add-bulk', title: 'Add jobs in bulk (100 per call)', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'drain-1x50', key: 'drain-1', title: 'Process a backlog, 1 worker process', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'drain-4x50', key: 'drain-4', title: 'Process a backlog, 4 worker processes', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'drain-8x50', key: 'drain-8', title: 'Process a backlog, 8 worker processes', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'latency-1k', key: 'latency-1k-p50', title: 'Pickup latency p50 at 1,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-1k', key: 'latency-1k-p99', title: 'Pickup latency p99 at 1,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'latency-5k', key: 'latency-5k-p50', title: 'Pickup latency p50 at 5,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-5k', key: 'latency-5k-p99', title: 'Pickup latency p99 at 5,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'latency-10k', key: 'latency-10k-p50', title: 'Pickup latency p50 at 10,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-10k', key: 'latency-10k-p99', title: 'Pickup latency p99 at 10,000 jobs/s', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'delayed', key: 'delayed-p50', title: 'Delayed job lateness p50', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.latenessMs.p50 },
  { id: 'delayed', key: 'delayed-p99', title: 'Delayed job lateness p99', unit: 'ms', higherIsBetter: false, longPoll: true, pick: (r) => r.latenessMs.p99 },
  { id: 'retry', key: 'retry', title: 'Retries (fail twice, succeed on the third attempt)', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
];

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function stats(mode: string, config: string, metric: Metric) {
  const entry = results.find((r: any) => r.mode === mode && r.config === config && r.id === metric.id);
  if (!entry?.runs?.length) return null;
  const values = entry.runs.map(metric.pick);
  const round = (x: number) => (metric.unit === 'ms' ? Math.round(x * 1000) / 1000 : Math.round(x));
  return { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)), runs: values.map(round) };
}

function mode(name: 'memory' | 'durable') {
  return METRICS.map((metric) => {
    const bunqueue = stats(name, metric.longPoll ? 'bunqueue-longpoll' : 'bunqueue', metric);
    const node = stats(name, 'bullmq-node', metric);
    const bun = stats(name, 'bullmq-bun', metric);
    const better = (a: typeof node, b: typeof node) =>
      !a ? b : !b ? a : metric.higherIsBetter ? (a.median >= b.median ? a : b) : a.median <= b.median ? a : b;
    const best = better(node, bun);
    const bullmqRuntime = best === node ? 'Node.js' : 'Bun';
    const ratio =
      bunqueue && best ? (metric.higherIsBetter ? bunqueue.median / best.median : best.median / bunqueue.median) : null;
    const { pick, id, ...meta } = metric;
    return {
      ...meta,
      scenario: id,
      bunqueue,
      bunqueueConfig: metric.longPoll ? 'pollTimeout: 5000' : 'defaults',
      bullmq: best,
      bullmqRuntime,
      bullmqNode: node,
      bullmqBun: bun,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    };
  });
}

const memoryOf = (m: string, system: string) => {
  const entry = results.find((r: any) => r.mode === m && r.id === 'memory-1m' && r.config.startsWith(system));
  return entry ? { idleMiB: Math.round(entry.idleMiB), backlogMiB: Math.round(entry.backlogMiB) } : null;
};

const data = {
  date: environment.date,
  machine: {
    cpu: 'AMD Ryzen 9 7950X3D, 16 cores / 32 threads, up to 5.76 GHz, 128 MiB L3 (two CCDs)',
    memory: '124 GiB',
    disk: '3x Samsung PM9A3 NVMe (MZQL21T9HCJR) in RAID 5, ext4',
    os: `${environment.os}, ${environment.kernel}, bare metal, CPU governor ${environment.governor}`,
    pinning: `broker on CPUs ${environment.brokerCpus} (two physical cores), clients on ${environment.clientCpus} (the other CCD)`,
    shared: 'a shared server: other services ran during the run, so each cell reports the median of five runs with its range',
  },
  versions: {
    bunqueue: environment.installed.bunqueue,
    bullmq: environment.installed.bullmq,
    ioredis: environment.installed.ioredis,
    redis: environment.redis.replace('redis:', ''),
    bun: environment.bun,
    node: environment.node.replace(/^v/, ''),
  },
  reps: environment.reps,
  memory: mode('memory'),
  durable: mode('durable'),
  footprint: {
    memory: { bunqueue: memoryOf('memory', 'bunqueue'), redis: memoryOf('memory', 'bullmq') },
    durable: { bunqueue: memoryOf('durable', 'bunqueue'), redis: memoryOf('durable', 'bullmq') },
  },
};

// Headline tiles: the four largest in-memory ratios among these, each a real result.
const TILE_LABELS: Record<string, string> = {
  'add-bulk': 'faster bulk adds',
  'add-concurrent': 'faster concurrent adds',
  'add-serial': 'faster single adds',
  'drain-1': 'more jobs processed, 1 worker process',
  'drain-4': 'more jobs processed, 4 worker processes',
  'drain-8': 'more jobs processed, 8 worker processes',
  retry: 'faster retries',
  'delayed-p99': 'more punctual delayed jobs (p99)',
  'delayed-p50': 'more punctual delayed jobs (median)',
};
(data as any).tiles = data.memory
  .filter((m) => TILE_LABELS[m.key] && m.ratio !== null && m.ratio > 1)
  .sort((a, b) => b.ratio! - a.ratio!)
  .filter((m, i, all) => all.findIndex((x) => x.scenario === m.scenario) === i)
  .slice(0, 4)
  .map((m) => ({ key: m.key, label: TILE_LABELS[m.key] }));

const target = new URL('../../../docs/src/data/benchmark-vs-bullmq.json', import.meta.url).pathname;
writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${target}`);
for (const m of ['memory', 'durable'] as const) {
  for (const row of data[m]) console.log(`${m} ${row.key}: bunqueue ${row.bunqueue?.median} vs BullMQ (${row.bullmqRuntime}) ${row.bullmq?.median} → ${row.ratio}x`);
}
