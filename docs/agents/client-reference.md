# Client Reference (agents)

Client API summaries moved verbatim from the root `CLAUDE.md`; this introduction is
new. The user-facing guides
under [`docs/src/content/docs/`](../src/content/docs/) and the feature documents under
[`docs/features/`](../features/) are authoritative; correct this page in the same
change-set when they change. Index: [docs/agents/README.md](./README.md).

## Simple Mode (Bunqueue)

All-in-one Queue + Worker with routes, middleware, and cron:

```typescript
import { Bunqueue } from 'bunqueue/client';

const app = new Bunqueue('tasks', {
  embedded: true,
  // Single processor OR named routes
  routes: {
    'send-email': async (job) => { return { sent: true }; },
    'send-sms': async (job) => { return { sent: true }; },
  },
  concurrency: 10,
});

// Middleware (onion model: mw1 → mw2 → processor → mw2 → mw1)
app.use(async (job, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`${job.name} took ${Date.now() - start}ms`);
  return result;
});

// Cron
await app.cron('daily', '0 9 * * *', { type: 'report' });
await app.every('ping', 30000, { type: 'health' });

// Events, add, control
app.on('completed', (job, result) => {});
await app.add('send-email', { to: 'user@test.com' });
app.pause(); app.resume();
await app.close();
```

Key: `Bunqueue` = wrapper around `Queue` + `Worker`. Use `processor` OR `routes`, not both. Middleware wraps the processor. Cron delegates to `queue.upsertJobScheduler()`. For distributed (separate producer/consumer), use `Queue` + `Worker` directly.

Source: `src/client/bunqueue.ts`

## Workflow Engine

Multi-step orchestration with saga compensation, branching, parallel steps, retry, nested workflows, loops (doUntil/doWhile), forEach, map, schema validation, subscribe, observability, and human-in-the-loop signals:

```typescript
import { Workflow, Engine } from 'bunqueue/workflow';

const flow = new Workflow('order')
  .step('validate', async (ctx) => {
    const { orderId } = ctx.input as { orderId: string };
    return { orderId };
  })
  .step('charge', async (ctx) => {
    return { txId: 'tx_123' };
  }, { compensate: async () => { /* auto-rollback on failure */ }, retry: 3 })
  .parallel((w) => w
    .step('notify-warehouse', async () => ({ notified: true }))
    .step('notify-email', async () => ({ sent: true }))
  )
  .step('classify', async () => ({ tier: 'basic' }))
  .branch((ctx) => (ctx.steps['classify'] as { tier: string }).tier)
  .path('vip', (w) => w.step('vip-handler', async () => ({ discount: 20 })))
  .path('basic', (w) => w.step('basic-handler', async () => ({ discount: 0 })))
  .forEach(                                        // iterate over items
    (ctx) => (ctx.input as { items: unknown[] }).items,
    'process-item', async (ctx) => { return { item: ctx.steps.__item }; },
  )
  .map('summary', (ctx) => ({ total: 42 }))       // synchronous transform
  .doUntil(                                         // loop until condition
    (ctx) => (ctx.steps['poll'] as any)?.ready,
    (w) => w.step('poll', async () => ({ ready: true })),
    { maxIterations: 10 },
  )
  .waitFor('approval', { timeout: 86400000 })      // pauses until engine.signal(), 24h timeout
  .subWorkflow('payment', (ctx) => ({ amount: 99 }))  // nested workflow
  .step('finalize', async (ctx) => {
    const decision = ctx.signals['approval'];
    const payment = ctx.steps['sub:payment'];
    return { done: true };
  });

const engine = new Engine({ embedded: true, onEvent: (e) => console.log(e.type) });
engine.register(flow);
engine.on('step:retry', (e) => logger.warn(e));
const run = await engine.start('order', { orderId: 'ORD-1' });
await engine.signal(run.id, 'approval', { approved: true });
engine.archive(7 * 24 * 60 * 60 * 1000); // archive old executions
const unsub = engine.subscribe(run.id, (e) => console.log(e.type)); // per-execution subscribe
```

Key: `Workflow` = pure DSL builder (step/branch/path/parallel/waitFor/subWorkflow/doUntil/doWhile/forEach/map). `Engine` = facade over Queue + Worker + SQLite Store + Executor + Emitter. Each step runs as a bunqueue job on `__wf:steps` queue. Features: retry with exponential backoff, parallel via Promise.allSettled, nested workflows via polling, signal timeout, loops (doUntil/doWhile/forEach), map transforms, schema validation AND coercion (duck-typed `.parse()`, its return value is used), per-execution subscribe, typed events (15 types), cleanup/archival. Compensation runs in reverse start order on failure, and an unresolved failed reversal keeps the chain parked instead of reporting a clean rollback.

Source: `src/client/workflow/` (workflow.ts, engine.ts, executor.ts, store.ts, runner.ts, emitter.ts, loops.ts, types.ts, compensator.ts, recovery.ts, waitFor.ts, rollbackControl.ts, storeSignals.ts, storeWaitExpiry.ts, storeCodec.ts, identity.ts, clock.ts, unwindPlan.ts, admission.ts)

The decision logic is pure and separately testable: `unwindPlan.ts` decides what an
unwind does with each record, `admission.ts` decides whether a node job may run, and
`clock.ts` is the single source of time and randomness, so a seed can drive the engine's
own non-determinism.

## Client SDK

```typescript
import { Queue, Worker } from 'bunqueue/client';

// Queue (TCP mode)
const queue = new Queue<T>('emails', { connection: { port: 6789 } });

// Queue (TCP + TLS): tls: true (system CAs) | { caFile } | { rejectUnauthorized: false }
const tlsQueue = new Queue<T>('emails', {
  connection: { host: 'queue.example.com', port: 6789, tls: { caFile: './ca.pem' } },
});

// Store-and-forward (edge → central): drains local jobs to a remote server.
// Remote failure → local retry/DLQ (nothing lost); deterministic remote jobId
// fwd:<queue>:<localId> dedupes re-forwards only while the remote job is live
// (waiting, delayed or active); completion or the DLQ releases the custom id, so a
// later re-forward creates a new job. Source: src/client/forwarder.ts
const fwd = embeddedQueue.forward({
  to: { host: 'central', port: 6789, tls: true },
  queue: 'ingest', // optional remote name
});
fwd.on('forwarded', (info) => {});
await fwd.close();

// Queue (embedded mode — programmatic dataPath, no env var needed)
const embeddedQueue = new Queue<T>('emails', {
  embedded: true,
  dataPath: './data/myapp.db',
});
await queue.add('send', { email: 'user@test.com' });
await queue.add('payment', data, { durable: true }); // Immediate disk write
queue.pause();
queue.resume();
queue.drain();
queue.obliterate();

// Worker
const worker = new Worker(
  'emails',
  async (job) => {
    await job.updateProgress(50);
    return { sent: true };
  },
  { concurrency: 5, heartbeatInterval: 10000 }
);

worker.on('completed', (job, result) => {});
worker.on('failed', (job, err) => {});

// Stall Detection (embedded only)
queue.setStallConfig({ stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 });

// DLQ (embedded only)
queue.setDlqConfig({ autoRetry: true, maxAge: 604800000, maxEntries: 10000 });
const entries = queue.getDlq({ reason: 'timeout' });
queue.retryDlq();
queue.purgeDlq();

// Auto-batching (TCP mode, enabled by default)
// Transparently batches concurrent add() calls into PUSHB commands.
// Strategy: flush immediately if idle, buffer during in-flight flush.
// Sequential await has zero overhead; concurrent adds get ~3x speedup.
const queue2 = new Queue('jobs', {
  autoBatch: { maxSize: 50, maxDelayMs: 5 },  // defaults
});
// Sequential: no penalty, each add() sends immediately
for (const item of items) {
  await queue2.add('task', item); // same speed as without batching
}
// Concurrent: adds batch into a single PUSHB round-trip (~3x faster)
await Promise.all([
  queue2.add('a', { x: 1 }),
  queue2.add('b', { x: 2 }),
  queue2.add('c', { x: 3 }),
]);
// Durable jobs bypass the batcher (sent as individual PUSH):
await queue2.add('critical', data, { durable: true });
// Disable auto-batching:
const queue3 = new Queue('jobs', { autoBatch: { enabled: false } });
```

## Job Options

```typescript
interface JobOptions {
  priority?: number; // Higher = sooner
  delay?: number; // ms before processing
  attempts?: number; // Maximum attempts, including the first (default: 3)
  backoff?: number; // Retry backoff (default: 1000ms)
  timeout?: number; // Processing timeout
  jobId?: string; // Custom ID; retained-ownership dedup (memory/SQLite default cache: 50,000 IDs; PostgreSQL checks DB)
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  durable?: boolean; // Bypass write buffer
}
```

## Worker Options

```typescript
interface WorkerOptions {
  concurrency?: number; // Parallel jobs (default: 1)
  heartbeatInterval?: number; // Stall detection (default: 10000, 0=disabled)
  batchSize?: number; // Pull batch (default: 10, max: 1000)
  pollTimeout?: number; // Long poll (default: 0, max: 30000)
  useLocks?: boolean; // Lock-based ownership (default: true)
}
```
