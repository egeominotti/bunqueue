<div align="center">

<a href="https://bunqueue.dev">
  <img src="https://raw.githubusercontent.com/egeominotti/bunqueue/main/.github/logo.png" alt="bunqueue logo" width="110" />
</a>

# bunqueue-client

**The official TypeScript client for [bunqueue](https://bunqueue.dev), the high-performance job queue server.**

The same `Queue`, `Worker` and `FlowProducer` API as `bunqueue/client`, for Node.js, Bun, Deno and Cloudflare Workers.

[![npm](https://img.shields.io/npm/v/bunqueue-client?color=d3156d&label=npm)](https://www.npmjs.com/package/bunqueue-client)
[![downloads](https://img.shields.io/npm/dm/bunqueue-client?color=ff4f9f)](https://www.npmjs.com/package/bunqueue-client)
[![license](https://img.shields.io/badge/license-MIT-1a1a2e)](https://github.com/egeominotti/bunqueue/blob/main/sdk/typescript/LICENSE)
[![runtimes](https://img.shields.io/badge/runtimes-Node%2020%2B%20%7C%20Bun%20%7C%20Deno%202%2B%20%7C%20Workers-2ea44f)](#runtime-support)
[![conformance](https://img.shields.io/badge/protocol-conformant%2018%2F18-d3156d)](https://github.com/egeominotti/bunqueue/tree/main/sdk/conformance)

[Documentation](https://bunqueue.dev/guide/sdks/) · [Quick Start](https://bunqueue.dev/guide/quickstart/) · [Protocol spec](https://github.com/egeominotti/bunqueue/blob/main/docs/protocol.md) · [Server](https://github.com/egeominotti/bunqueue) · [Changelog](https://github.com/egeominotti/bunqueue/blob/main/sdk/typescript/CHANGELOG.md)

</div>

---

bunqueue-client connects any JavaScript runtime to a bunqueue server over TCP.
It is not a second implementation: the package is built from the same source
as `bunqueue/client`, with only the runtime I/O replaced, so queues, workers,
flows, events, options and errors behave exactly as the bunqueue guides
describe. Its only runtime dependency is `msgpackr`.

> **Upgrading from 0.1.x?** 0.2.0 is a breaking release. Read
> [Migrating from 0.1.x](#migrating-from-01x), or keep the old API unchanged
> with `bunqueue-client/legacy`.

## Install

```sh
npm install bunqueue-client
```

pnpm, Yarn, `bun add bunqueue-client` and `deno add npm:bunqueue-client` work
the same way.

## Quick start

**1. Start a bunqueue server.** With Docker:

```sh
docker run -d --name bunqueue \
  --restart unless-stopped \
  -p 127.0.0.1:6789:6789 \
  -p 127.0.0.1:6790:6790 \
  -v bunqueue-data:/app/data \
  egeominotti/bunqueue:alpine
```

Or, with Bun installed, `bunx bunqueue start --host 127.0.0.1 --data-path ./bunqueue.db`.
Check that it is up with `curl --fail http://127.0.0.1:6790/health`.

**2. Add a job and process it.** Save this as `jobs.mjs`:

```javascript
import { Queue, Worker } from 'bunqueue-client';

const options = {
  embedded: false,
  connection: { host: '127.0.0.1', port: 6789 },
};
const queue = new Queue('emails', options);

const worker = new Worker(
  'emails',
  async (job) => {
    console.log('Processing:', job.data.to);
    return { sent: true };
  },
  options
);

worker.on('error', (error) => console.error(error));
await queue.add('welcome', { to: 'hello@example.com' });
```

**3. Run it.**

```sh
node jobs.mjs
```

The worker prints `Processing: hello@example.com` and keeps waiting for more
jobs until you stop it with Ctrl+C. The same file runs unchanged with
`bun jobs.mjs`; the [Quick Start guide](https://bunqueue.dev/guide/quickstart/)
has the Deno version.

## Wait for a result

`QueueEvents` streams one queue's lifecycle events. Pass it to
`waitJobUntilFinished` to get the value the processor returned:

```typescript
import { Queue, QueueEvents, Worker } from 'bunqueue-client';

const options = {
  embedded: false,
  connection: { host: '127.0.0.1', port: 6789 },
};
const queue = new Queue<{ to: string }>('emails', options);
const events = new QueueEvents('emails', options);
await events.waitUntilReady();

const worker = new Worker<{ to: string }>(
  'emails',
  async (job) => {
    await job.updateProgress(50);
    await job.log(`Sending to ${job.data.to}`);
    return { sent: true };
  },
  { ...options, concurrency: 5 }
);
worker.on('error', (error) => console.error(error));

const job = await queue.add('welcome', { to: 'user@example.com' });
console.log(await queue.waitJobUntilFinished(job.id, events, 30_000)); // { sent: true }

await worker.close();
events.close();
await queue.close();
```

## Runtime support

| Runtime            | Version              | Connect over TCP | Embedded mode           |
| ------------------ | -------------------- | ---------------- | ----------------------- |
| Node.js            | 20 or newer          | Yes              | No                      |
| Bun                | 1.4 or newer         | Yes              | Yes (`embedded: true`)  |
| Deno               | 2 or newer           | Yes              | No                      |
| Cloudflare Workers | `nodejs_compat` flag | Yes              | No                      |

- **ESM only.** `require('bunqueue-client')` fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. From CommonJS, load it with
  `await import('bunqueue-client')`. To ship CommonJS (for example to AWS
  Lambda), write your code with `import` and bundle it: the published
  JavaScript has no top-level `await`, so `esbuild --bundle --format=cjs`
  produces a working CommonJS file. A `require('bunqueue-client')` call does
  not resolve, even in a bundler.
- **Embedded mode needs Bun.** It runs the bunqueue engine and its SQLite
  database inside your process, with no server. Under Bun the package loads
  the real engine the first time `embedded: true` is used. Node.js, Deno and
  Workers never load `bun:sqlite`: there, `embedded: true` throws
  `Embedded mode requires Bun; use a TCP connection in this runtime.`. Under
  Bun, a CommonJS re-bundle of the package reports that it cannot load the
  engine; import the published package to use embedded mode.
- **Deno.** `deno add` may warn that lifecycle scripts did not run for
  `msgpackr-extract`. That optional native accelerator is not needed; the
  client works without it. Recent Deno versions also refuse npm releases
  younger than 24 hours unless you pass `--minimum-dependency-age=0` (Deno's
  own error message states the 24-hour default), so `deno add` picks the
  previous version during a release's first day.
- **Server settings stay on the server.** Database, persistence and retention
  are configured on the bunqueue broker, not in the client.

## Using the API

The client is the canonical bunqueue API. Follow the
[Queue](https://bunqueue.dev/guide/queue/),
[Worker](https://bunqueue.dev/guide/worker/) and
[Flow](https://bunqueue.dev/guide/flow/) guides, importing from
`bunqueue-client` instead of `bunqueue/client`.

- **Connection.** Pass `connection: { host, port, token, tls }`. `token`
  authenticates against a broker started with `AUTH_TOKENS`; `tls: true`
  connects over TLS with the system certificate authorities.
- **Await the `*Async` methods over TCP.** The synchronous reads and admin
  calls (`isPaused()`, `count()`, `getJobs()`, `getDlq()`, `pause()`,
  `obliterate()` and the rest) serve embedded mode. Over TCP the reads return
  a default without asking the broker, and the admin calls send their command
  without waiting for it. Use `isPausedAsync()`, `countAsync()`,
  `getJobsAsync()`, `getDlqAsync()`, `pauseAsync()`, `obliterateAsync()` and
  the other `*Async` variants; [the migration tables](#3-await-the-async-control-methods-in-tcp-mode)
  list them all.
- **Same contract everywhere.** Constructor defaults, per-job defaults, return
  shapes, errors and events follow the canonical client. `QueueEvents`,
  `FlowProducer`, `QueueGroup`, Simple Mode (`Bunqueue`), job groups,
  processor batches and the `QueuePro`, `WorkerPro` and `QueueEventsPro`
  aliases share the same implementation.
- **Sandboxed workers.** `SandboxedWorker` runs processors in worker threads
  through a portable adapter. It is experimental execution isolation, not a
  security boundary, and the processor module must be executable by the host
  runtime.
- **Low-level access.** `Connection`, `ConnectionPool` and the telemetry
  helpers are additional exports; they do not change the Queue or Worker
  types.

## TypeScript

Type declarations ship with the package and are self-contained: they reference
neither `bun-types` nor Bun globals, and the package does not install
`@types/node`. Node.js projects bring their own `@types/node` (20 or newer).
The declarations type-check under `strict`, `module: "NodeNext"` and
`skipLibCheck: false`, with or without the DOM library.

```typescript
import { Queue, Worker, type Job } from 'bunqueue-client';

interface Email {
  to: string;
}

const options = { embedded: false, connection: { host: '127.0.0.1', port: 6789 } };
const queue = new Queue<Email>('emails', options);

const worker = new Worker<Email, { sent: boolean }>(
  'emails',
  async (job: Job<Email>) => ({ sent: job.data.to.endsWith('@example.com') }),
  options
);
worker.on('completed', (job, result) => console.log(job.id, result.sent));

await queue.add('welcome', { to: 'hello@example.com' });
```

## Migrating from 0.1.x

0.2.0 made the canonical `bunqueue/client` API the default entry. Nothing in
this section applies to code that switches its import to
`bunqueue-client/legacy`.

### 1. Keep the 0.1.x API unchanged

The compatibility entry keeps the historical flat-option API, method
signatures, `Job` class, error classes and wire types exactly as in 0.1.x.
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
`SandboxedWorker` and `QueueGroup.getQueue()`/`getWorker()`. The canonical
client never read top-level `host`, `port`, `token` or `tls`: it silently
connected to `localhost:6789` without the token or TLS. Those keys now throw
an `Error` that names the keys to move.

### 3. Await the `*Async` control methods in TCP mode

`pause()`, `resume()`, `drain()`, `obliterate()`, `remove()`,
`setGlobalConcurrency()`, `removeGlobalConcurrency()`, `setGlobalRateLimit()`,
`removeGlobalRateLimit()`, `setStallConfig()`, `setDlqConfig()`, `retryDlq()`,
`retryDlqByFilter()`, `purgeDlq()` and `retryCompleted()` return synchronously
and send their command without waiting for the broker. Awaiting them waits for
nothing, and a job added right after `obliterate()` or `drain()` can be
processed first and then wiped. Use the variant that resolves once the broker
has applied the command:

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

| 0.1.x call (TCP)                                                                        | 0.2.0 sync result in TCP mode | Use instead                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `await queue.isPaused()`                                                                | `false`                       | `await queue.isPausedAsync()`                                  |
| `await queue.count()`                                                                   | `0`                           | `await queue.countAsync()`                                     |
| `await queue.getJobs(...)`                                                              | `[]`                          | `await queue.getJobsAsync(...)`                                |
| `await queue.getWaiting()` (and `getActive`, `getDelayed`, `getCompleted`, `getFailed`) | `[]`                          | `await queue.getWaitingAsync()` (and the matching `*Async`)    |
| `await queue.getCountsPerPriority()`                                                    | `{}`                          | `await queue.getCountsPerPriorityAsync()`                      |
| `await queue.getDlq(...)`                                                               | `[]`                          | `await queue.getDlqAsync(...)`                                 |
| `queue.getDlqStats()`                                                                   | empty stats                   | `await queue.getDlqStatsAsync()`                               |
| `queue.getStallConfig()` / `getDlqConfig()`                                             | local cache or defaults       | `await queue.getStallConfigAsync()` / `getDlqConfigAsync()`    |
| `await queue.clean(...)`                                                                | `[]`                          | `await queue.cleanAsync(...)`                                  |

`getJobCounts()` returns a `Promise` in TCP mode; await it or call
`getJobCountsAsync()`.

### 5. `Job` is a type, not a class

```typescript
// Before (0.1.x)
import { Job } from 'bunqueue-client';
if (value instanceof Job) { /* ... */ }
// After (0.2.0): jobs come from add(), getJob() and Worker callbacks
import type { Job } from 'bunqueue-client';
```

There is no `job.raw`; use `job.toJSON()` (`JobJson`) or `job.asJSON()`
(`JobJsonRaw`).

### 6. Removed type exports

| 0.1.x type                                            | 0.2.0 replacement                                         |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `BunqueueConnection`                                  | `ConnectionOptions`                                       |
| `TlsOption`                                           | `ConnectionOptions['tls']`                                |
| `BackoffOptions`                                      | `Exclude<NonNullable<JobOptions['backoff']>, number>`     |
| `DeduplicationOptions`                                | `NonNullable<JobOptions['deduplication']>`                |
| `RepeatOptions`                                       | `NonNullable<JobOptions['repeat']>`                       |
| `SchedulerOptions`                                    | `RepeatOpts` (with `JobTemplate` for the job)             |
| `FlowOptions`                                         | `FlowOpts`                                                |
| `GetFlowOptions`                                      | `Parameters<FlowProducer['getFlow']>[0]`                  |
| `BulkJobEntry<T>`                                     | `Parameters<Queue<T>['addBulk']>[0][number]`              |
| `JobCounts`                                           | `Awaited<ReturnType<Queue['getJobCountsAsync']>>`         |
| `JobStateName`                                        | `Awaited<ReturnType<Queue['getJobState']>>`               |
| `JobRaw`                                              | `JobJson` / `JobJsonRaw`                                  |
| `CircuitState`                                        | `ReturnType<Bunqueue['getCircuitState']>`                 |
| `TelemetryErrorOperation`                             | `Extract<TelemetryEvent, { type: 'error' }>['operation']` |
| `WorkerEventMap`, `AckBatchOptions`                   | none: `Worker.on()` overloads type every event            |
| `Command`, `Response`, and the `*Response` wire types | none: import them from `bunqueue-client/legacy`           |

### 7. Error classes

`AuthError`, `BunqueueError`, `CommandError`, `CommandTimeoutError`,
`ConnectionClosedError` and `SerializationError` are still exported, but only
the low-level `Connection` and `ConnectionPool` throw them. `Queue`, `Worker`,
`FlowProducer` and `QueueEvents` reject with plain `Error` instances (for
example `Command timeout`, `Authentication failed`, `Connection lost`, or the
broker's error text), so `instanceof` checks against those classes no longer
match. `UnrecoverableError`, `DelayedError` and `RateLimitError` are the
canonical processor errors.

### 8. TypeScript setup

The package no longer installs `bun-types` or `@types/node`. Node.js projects
keep their own `@types/node` (20 or newer); Bun globals are not declared.

## Development

This package is built from the repository's canonical client sources
(`src/client`); only the runtime I/O adapters live in this directory. From
`sdk/typescript`:

```sh
bun run build                 # bundle the canonical sources, emit declarations and a source manifest
bun run test:parity           # exports, signatures, options and events match bunqueue/client
bun run test:shared-contract  # the documentation suites, run against the built package
bun run test:canonical        # the canonical Queue and Worker scenarios
```

The build records the hash of every source and generated artifact. The parity
checker rejects missing or stale artifacts, missing exports, and changed
signatures, constructors, overloads, options, nested type references or event
contracts. A failed parity gate blocks the build and the publish; it cannot be
bypassed by updating an API count or accepting a new snapshot. CI runs the
canonical scenarios on Bun, Node.js and Deno, and exercises the built package
in the protocol conformance suite and in Cloudflare Workers.

## License

[MIT](./LICENSE)
