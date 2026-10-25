/**
 * Turns results/<stamp>/summary.json into report.md: one table per storage mode
 * with the median of five measured runs and the min–max range, and the ratio of
 * bunqueue to the better of BullMQ on Node.js and BullMQ on Bun.
 *
 *   bun src/report.ts results/<stamp>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: bun src/report.ts results/<stamp>');
const { environment: env, results } = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));

type Row = { id: string; title: string; unit: string; higherIsBetter: boolean; pick: (run: any) => number };
const ROWS: Row[] = [
  { id: 'enqueue-serial', title: 'Add, one at a time', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'enqueue-concurrent', title: 'Add, 64 in flight', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'enqueue-bulk', title: 'addBulk, 100 per call', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.opsPerSec },
  { id: 'drain-1x50', title: 'Drain, 1 worker process x 50', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'drain-4x50', title: 'Drain, 4 worker processes x 50', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'drain-8x50', title: 'Drain, 8 worker processes x 50', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
  { id: 'latency-1k', title: 'Pickup latency p50 at 1,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-1k', title: 'Pickup latency p99 at 1,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'latency-5k', title: 'Pickup latency p50 at 5,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-5k', title: 'Pickup latency p99 at 5,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'latency-10k', title: 'Pickup latency p50 at 10,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p50 },
  { id: 'latency-10k', title: 'Pickup latency p99 at 10,000 jobs/s', unit: 'ms', higherIsBetter: false, pick: (r) => r.pickupLatencyMs.p99 },
  { id: 'delayed', title: 'Delayed job lateness p50', unit: 'ms', higherIsBetter: false, pick: (r) => r.latenessMs.p50 },
  { id: 'delayed', title: 'Delayed job lateness p99', unit: 'ms', higherIsBetter: false, pick: (r) => r.latenessMs.p99 },
  { id: 'retry', title: 'Retries (3 attempts per job)', unit: 'jobs/s', higherIsBetter: true, pick: (r) => r.jobsPerSec },
];

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v: number, unit: string) =>
  Number.isNaN(v) ? '–' : unit === 'ms' ? (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US')) : Math.round(v).toLocaleString('en-US');

function cell(mode: string, config: string, row: Row) {
  const entry = results.find((r: any) => r.mode === mode && r.config === config && r.id === row.id);
  if (!entry?.runs) return null;
  const values = entry.runs.map(row.pick);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

const out: string[] = [];
out.push('# bunqueue vs BullMQ + Redis', '');
out.push(
  `Run ${env.date}: ${env.cpu} (${env.logicalCpus} logical CPUs), ${env.os}, ${env.kernel}, governor ${env.governor}; ` +
    `Bun ${env.bun}, Node.js ${env.node}, ${env.docker}, ${env.redis}; bunqueue ${env.installed.bunqueue}, BullMQ ${env.installed.bullmq}, ioredis ${env.installed.ioredis}. ` +
    `Broker on CPUs ${env.brokerCpus}, clients on ${env.clientCpus}. Each cell: median of ${env.reps} measured runs after one warm-up, with the min–max range.`,
  ''
);

for (const mode of ['memory', 'durable']) {
  out.push(`## ${mode === 'memory' ? 'In memory' : 'Durable (bunqueue SQLite WAL vs Redis AOF everysec)'}`, '');
  out.push('| Scenario | bunqueue | bunqueue, long polling | BullMQ on Node.js | BullMQ on Bun | bunqueue vs best BullMQ |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of ROWS) {
    const c = (id: string) => cell(mode, id, row);
    const bq = c('bunqueue');
    const lp = c('bunqueue-longpoll');
    const node = c('bullmq-node');
    const bun = c('bullmq-bun');
    const show = (x: ReturnType<typeof c>) => (x ? `${fmt(x.median, row.unit)} <small>(${fmt(x.min, row.unit)}–${fmt(x.max, row.unit)})</small>` : '–');
    const bullBest = [node, bun].filter(Boolean).map((x) => x!.median);
    const best = bullBest.length ? (row.higherIsBetter ? Math.max(...bullBest) : Math.min(...bullBest)) : NaN;
    const ours = [bq, lp].filter(Boolean).map((x) => x!.median);
    const oursBest = ours.length ? (row.higherIsBetter ? Math.max(...ours) : Math.min(...ours)) : NaN;
    const ratio = row.higherIsBetter ? oursBest / best : best / oursBest;
    out.push(`| ${row.title} (${row.unit}) | ${show(bq)} | ${show(lp)} | ${show(node)} | ${show(bun)} | **${Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : '–'}** |`);
  }
  const mem = (system: string) => results.find((r: any) => r.mode === mode && r.id === 'memory-1m' && r.config.startsWith(system));
  const bm = mem('bunqueue');
  const rm = mem('bullmq');
  if (bm && rm) {
    out.push('', `Broker resident memory with a 1,000,000-job backlog: bunqueue ${Math.round(bm.backlogMiB)} MiB (idle ${Math.round(bm.idleMiB)} MiB), Redis ${Math.round(rm.backlogMiB)} MiB (idle ${Math.round(rm.idleMiB)} MiB).`);
  }
  out.push('');
}
out.push(
  'Ratios compare the better bunqueue configuration with the better BullMQ runtime; above 1x bunqueue is ahead (higher throughput or lower latency). For latency rows the ratio is BullMQ latency / bunqueue latency.'
);
writeFileSync(join(dir, 'report.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
