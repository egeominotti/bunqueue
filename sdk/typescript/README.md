# bunqueue-client

The cross-runtime distribution of the canonical `bunqueue/client` API.
Queue, Worker, QueueEvents, QueueGroup, FlowProducer, Simple Mode, groups,
processor batches, options, job objects, and errors come from the same source.
The portable build replaces runtime I/O primitives; it does not maintain a
second implementation of queue or worker behavior.

> **Upgrading from 0.1.x?** 0.2.0 is a breaking release: the default entry is
> now the canonical client. Read [Migrating from 0.1.x](#migrating-from-01x),
> or keep the old API unchanged with `bunqueue-client/legacy`.

## Install and run

```sh
npm install bunqueue-client
```

Start a bunqueue broker, then use the same code in Node.js, Deno, or Bun:

```typescript
import { Queue, Worker, QueueEvents } from 'bunqueue-client';

const options = {
  embedded: false,
  connection: { host: '127.0.0.1', port: 6789 },
};
const queue = new Queue<{ to: string }>('emails', options);
const events = new QueueEvents('emails', options);
await events.waitUntilReady();
const worker = new Worker('emails', async (job) => {
  await job.updateProgress(50);
  await job.log('Sending email');
  return { sent: true };
}, { ...options, concurrency: 5 });
worker.on('error', console.error);

const job = await queue.add('welcome', { to: 'user@example.com' });
const result = await queue.waitJobUntilFinished(job.id, events, 30_000);
console.log(result);

await worker.close();
events.close();
await queue.close();
```

Node.js 20+, Bun, Deno 2+, and Cloudflare Workers with `nodejs_compat` can
connect over TCP. Install with npm-compatible tooling in the chosen runtime.
The embedded SQLite engine continues to require Bun; under Bun the package
loads the actual shared engine synchronously the first time `embedded: true`
is used. Node, Deno, and Workers never load `bun:sqlite`. Database
configuration for TCP belongs on the broker.

The published JavaScript has no top-level `await`, so CommonJS bundlers
(for example `esbuild --bundle --format=cjs` for AWS Lambda) accept it. esbuild
reports one harmless `empty-import-meta` warning for the Bun-only engine
loader; embedded mode is unavailable from a CommonJS re-bundle and says so.

TypeScript declarations are self-contained: they reference neither `bun-types`
nor Bun globals, and the package does not install `@types/node`. Node projects
use their own `@types/node` (20 or newer) and type-check with
`skipLibCheck: false`, with or without the DOM library.

## One public contract

Use the [Queue guide](https://bunqueue.dev/guide/queue/),
[Worker guide](https://bunqueue.dev/guide/worker/), and
[Flow guide](https://bunqueue.dev/guide/flow/), replacing the import path
`bunqueue/client` with `bunqueue-client`.

- Connection settings use `connection: { host, port, token, ... }`.
- Constructor defaults, per-job defaults, return shapes, errors, and events
  follow the canonical Bun client.
- Use the `Async` administrative/query variants for authoritative TCP reads
  and ordered operations. The synchronous embedded-only methods retain the
  canonical contract; they do not become asynchronous by changing packages.
- `QueuePro`, `WorkerPro`, and `QueueEventsPro` are the same canonical aliases.
- Native processor batches and broker-authoritative job groups share the
  same implementation and lease/counter transitions as the Bun client.
- `SandboxedWorker` shares its pool logic, with a portable worker-thread
  adapter. It remains experimental execution isolation, not a security
  boundary. Processor modules must be executable by the host runtime.

Low-level `Connection`, `ConnectionPool`, and telemetry helpers remain
additive exports. They do not redefine canonical Queue or Worker types.

## Migrating from 0.1.x

0.2.0 makes the canonical `bunqueue/client` API the default entry. Nothing
below applies to code that switches its import to `bunqueue-client/legacy`.

### 1. Keep the 0.1.x API unchanged

The compatibility entry keeps the historical flat-option API, method
signatures, `Job` class, error classes, and wire types exactly as in 0.1.x.
See [LEGACY.md](./LEGACY.md).

```typescript
// Before (0.1.x)
import { Queue, Worker } from 'bunqueue-client';
// After: same behavior, no other change
import { Queue, Worker } from 'bunqueue-client/legacy';
```

### 2. Connection options live in `connection`

```typescript
// Before (0.1.x)
const queue = new Queue('emails', { host: 'queue.internal', port: 6789, token, tls: true });
// After (0.2.0)
const queue = new Queue('emails', {
  connection: { host: 'queue.internal', port: 6789, token, tls: true },
});
```

The same applies to `Worker`, `FlowProducer`, `QueueEvents`, `Bunqueue`,
`SandboxedWorker`, `QueueGroup.getQueue()/getWorker()`, and the workflow
`Engine`. Top-level `host`, `port`, `token`, or `tls` were never read by the
canonical client, which silently connected to `localhost:6789` without the
token or TLS. They now throw an `Error` that names the keys to move.

### 3. Await the `*Async` control methods in TCP mode

`pause()`, `resume()`, `drain()`, `obliterate()`, `remove()`,
`setGlobalConcurrency()`, `removeGlobalConcurrency()`, `setGlobalRateLimit()`,
`removeGlobalRateLimit()`, `setStallConfig()`, `setDlqConfig()`, `retryDlq()`,
`retryDlqByFilter()`, `purgeDlq()`, and `retryCompleted()` return
synchronously and send their command without waiting for the broker. Awaiting
them waits for nothing, and a job added right after `obliterate()` or
`drain()` can be processed first and then wiped. Use the variant that resolves
after the broker applied the command:

```typescript
// Before (0.1.x): every method returned a broker-acknowledged Promise
await queue.obliterate();
await queue.add('fresh', data);
// After (0.2.0)
await queue.obliterateAsync(); // also pauseAsync, resumeAsync, drainAsync, removeAsync, ...
await queue.add('fresh', data);
```

### 4. Use `*Async` reads in TCP mode

The synchronous reads are embedded-only. In TCP mode they return a default
without contacting the broker:

| 0.1.x call (TCP)                      | 0.2.0 sync result in TCP mode | Use instead                           |
| ------------------------------------- | ----------------------------- | ------------------------------------- |
| `await queue.isPaused()`              | `false`                       | `await queue.isPausedAsync()`         |
| `await queue.count()`                 | `0`                           | `await queue.countAsync()`            |
| `await queue.getJobs(...)`            | `[]`                          | `await queue.getJobsAsync(...)`       |
| `await queue.getWaiting()` (and `getActive`, `getDelayed`, `getCompleted`, `getFailed`) | `[]` | `await queue.getWaitingAsync()` (and the matching `*Async`) |
| `await queue.getCountsPerPriority()`  | `{}`                          | `await queue.getCountsPerPriorityAsync()` |
| `await queue.getDlq(...)`             | `[]`                          | `await queue.getDlqAsync(...)`        |
| `queue.getDlqStats()`                 | empty stats                   | `await queue.getDlqStatsAsync()`      |
| `queue.getStallConfig()` / `getDlqConfig()` | local cache or defaults | `await queue.getStallConfigAsync()` / `getDlqConfigAsync()` |
| `await queue.clean(...)`              | `[]`                          | `await queue.cleanAsync(...)`         |

`getJobCounts()` returns a `Promise` in TCP mode; await it or call
`getJobCountsAsync()`.

### 5. `Job` is a type, not a class

```typescript
// Before (0.1.x)
import { Job } from 'bunqueue-client';
if (value instanceof Job) { /* ... */ }
// After (0.2.0): jobs come from add(), getJob(), and Worker callbacks
import type { Job } from 'bunqueue-client';
```

There is no `job.raw`; use `job.toJSON()` (`JobJson`) or `job.asJSON()`
(`JobJsonRaw`).

### 6. Removed type exports

| 0.1.x type                                                 | 0.2.0 replacement                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `BunqueueConnection`                                       | `ConnectionOptions`                                        |
| `TlsOption`                                                | `ConnectionOptions['tls']`                                 |
| `BackoffOptions`                                           | `Exclude<NonNullable<JobOptions['backoff']>, number>`      |
| `DeduplicationOptions`                                     | `NonNullable<JobOptions['deduplication']>`                 |
| `RepeatOptions`                                            | `NonNullable<JobOptions['repeat']>`                        |
| `SchedulerOptions`                                         | `RepeatOpts` (with `JobTemplate` for the job)              |
| `FlowOptions`                                              | `FlowOpts`                                                 |
| `GetFlowOptions`                                           | `Parameters<FlowProducer['getFlow']>[0]`                   |
| `BulkJobEntry<T>`                                          | `Parameters<Queue<T>['addBulk']>[0][number]`               |
| `JobCounts`                                                | `Awaited<ReturnType<Queue['getJobCountsAsync']>>`          |
| `JobStateName`                                             | `Awaited<ReturnType<Queue['getJobState']>>`                |
| `JobRaw`                                                   | `JobJson` / `JobJsonRaw`                                   |
| `CircuitState`                                             | `ReturnType<Bunqueue['getCircuitState']>`                  |
| `TelemetryErrorOperation`                                  | `Extract<TelemetryEvent, { type: 'error' }>['operation']`  |
| `WorkerEventMap`, `AckBatchOptions`                        | none: `Worker.on()` overloads type every event             |
| `Command`, `Response`, and the `*Response` wire types      | none: import them from `bunqueue-client/legacy`            |

### 7. Error classes

`AuthError`, `BunqueueError`, `CommandError`, `CommandTimeoutError`,
`ConnectionClosedError`, and `SerializationError` are still exported, but only
the low-level `Connection` and `ConnectionPool` throw them. `Queue`, `Worker`,
`FlowProducer`, and `QueueEvents` reject with plain `Error` instances (for
example `Command timeout`, `Authentication failed`, `Connection lost`, or the
broker's error text), so `instanceof` checks against those classes no longer
match. `UnrecoverableError`, `DelayedError`, and `RateLimitError` are the
canonical processor errors.

### 8. TypeScript setup

The package no longer installs `bun-types` or `@types/node`. Node projects keep
their own `@types/node` (20 or newer); Bun globals are not declared.

## Parity gates

```sh
bun run build
bun run test:parity
bun run test:shared-contract
bun run test:canonical
```

The build consumes the repository's canonical sources and emits a manifest
covering source hashes and every generated artifact. The parity checker
rejects missing/stale artifacts, missing exports, changed signatures,
constructors, overloads, options, nested type references, and event contracts.
The unchanged native documentation suites also run against the built package
with real embedded engines and TCP brokers. Differential and generated-history
tests check results, states, counters, and lifecycle events.

Bun, Node, and Deno run the canonical public scenarios in CI. Protocol
conformance and Cloudflare Workers exercise the built package too. A failed
parity gate blocks the SDK build/publish preparation; it cannot be bypassed by
updating an API count or accepting a new snapshot.

Only `msgpackr` is needed at runtime for protocol serialization. Build and test
tooling stays in development dependencies. The Bun-only backend is loaded
conditionally and retains the same storage/runtime requirements as bunqueue.
