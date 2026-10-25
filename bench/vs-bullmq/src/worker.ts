/**
 * Worker process for one scenario. Started by scenario.ts (pinned to the client
 * cores), it creates a consumer, prints `{"type":"ready"}`, starts consuming on "go"
 * and, on "stop", closes and prints what it observed:
 * - every job id it processed and how many times (exact-delivery checks),
 * - per-kind samples: pickup latency (latency), lateness against the due time (delayed).
 * Progress goes to stdout every 100 ms so the coordinator can tell when it is done.
 */
import { createInterface } from 'node:readline';
import { now } from './stats.ts';
import { loadSystem, type SystemName } from './systems.ts';

const system = await loadSystem(process.env.BENCH_SYSTEM as SystemName);
const queue = process.env.BENCH_QUEUE!;
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 1);
const kind = process.env.BENCH_KIND ?? 'drain';
const succeedOnAttempt = Number(process.env.BENCH_SUCCEED_ON_ATTEMPT ?? 1);

const invocations = new Map<string, number>();
const samples: number[] = [];
let completed = 0;
let lastCompletion = 0;

const consumer = await system.consumer(
  queue,
  (job) => {
    const started = now();
    invocations.set(job.id, (invocations.get(job.id) ?? 0) + 1);
    if (kind === 'latency') samples.push(started - job.data.t);
    else if (kind === 'delayed') samples.push(started - job.data.due);
    else if (kind === 'retry' && invocations.get(job.id)! < succeedOnAttempt) {
      throw new Error('planned failure');
    }
    completed++;
    lastCompletion = now();
    return null;
  },
  concurrency,
  JSON.parse(process.env.BENCH_WORKER_OPTIONS ?? '{}')
);

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({ type: 'ready' });

let progress: ReturnType<typeof setInterval> | undefined;
const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  if (line === 'go') {
    consumer.run();
    progress = setInterval(() => send({ type: 'progress', completed }), 100);
  } else if (line === 'stop') {
    clearInterval(progress);
    await consumer.close();
    let calls = 0;
    for (const n of invocations.values()) calls += n;
    send({
      type: 'done',
      completed,
      calls,
      lastCompletion,
      ids: [...invocations.keys()],
      attempts: [...invocations.values()],
      samples,
    });
    input.close();
    setTimeout(() => process.exit(0), 50);
  }
});
