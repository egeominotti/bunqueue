# Simple Mode (Bunqueue all-in-one)

> **Category:** Client SDK · **Source:** `src/client/bunqueue.ts`, `src/client/bunqueue/runtime.ts`, `src/client/bunqueue/types.ts`, `src/client/bunqueue/validation.ts`, `src/client/bunqueue/circuitBreaker.ts`, `src/client/bunqueue/batch.ts`, `src/client/bunqueue/retry.ts`, `src/client/bunqueue/aging.ts`, `src/client/bunqueue/cancellation.ts`, `src/client/bunqueue/triggers.ts`, `src/client/bunqueue/ttl.ts`, `src/client/bunqueue/dlqRateLimit.ts`, `src/client/bunqueue/dedupDebounce.ts`

## Purpose

`Bunqueue` is a thin all-in-one wrapper that constructs a [`Queue`](./client-queue-sdk.md) and a [`Worker`](./client-worker-sdk.md) for the same queue name and stitches together a single processing pipeline. It exists so a single process can both produce and consume jobs through one object, while layering opt-in conveniences — named route handlers, an onion middleware chain, in-process retry with backoff, a circuit breaker, batch accumulation, priority aging, TTL expiry, graceful cancellation, event triggers, dedup/debounce defaults, and DLQ/rate-limit passthrough — that the bare `Queue`/`Worker` do not provide. It does not implement a new transport or storage path: every queue operation delegates to the underlying `Queue`/`Worker` (TCP or embedded).

## Responsibilities & Scope

Owns:

- Construction and lifecycle of a paired `Queue` + `Worker` (`src/client/bunqueue/runtime.ts:39-88`, shutdown in `src/client/bunqueue.ts:241-248`).
- Mode selection: exactly one of `processor`, `routes`, or `batch` (`src/client/bunqueue/runtime.ts:40-43`).
- Validation and normalization of its own duration and count options before the `Queue` and `Worker` exist (`resolveBunqueueFeatures` in `src/client/bunqueue/validation.ts`, called at `runtime.ts:47`), and of the `cancel()` grace period (`src/client/bunqueue.ts:98-104`). See [Option validation](#option-validation).
- The per-job processing pipeline: circuit-breaker gate → TTL gate → cancellation registration → optional retry wrapper → middleware onion → base processor (`src/client/bunqueue/runtime.ts:127-185`).
- In-process subsystems: `WorkerCircuitBreaker`, `BatchAccumulator`, `PriorityAger`, `CancellationManager`, `TtlChecker`, `TriggerManager`, `DedupDebounceMerger`, `DlqRateLimitManager`.
- Re-exposing `add`/`addBulk`/`getJob`/counts, cron helpers, pause/resume, and event subscription as a flat API.

Does NOT own (delegated):

- Actual enqueue/dequeue/ack/fail, persistence, sharding — owned by [Core Queue Engine](./core-queue-engine.md) and [Job Lifecycle](./job-lifecycle.md) via `Queue`/`Worker`.
- Cron/scheduler semantics — `cron`/`every`/`removeCron`/`listCrons` delegate to `Queue.upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers` ([Scheduler & Cron](./scheduler-and-cron.md)); the cron layer rejects an `every` interval that is not a positive safe integer of milliseconds (`src/domain/types/cron.ts`).
- DLQ storage and rate limiting — `DlqRateLimitManager` is a pure mixin over `Queue` methods ([Dead Letter Queue](./dead-letter-queue.md), [Rate Limiting & Concurrency](./rate-limiting-and-concurrency.md)).
- Deduplication/debounce enforcement — `DedupDebounceMerger` only injects `JobOptions.deduplication`/`debounce`. The server enforces deduplication (via `uniqueKey`, [Deduplication & Unique Jobs](./deduplication-and-unique.md)); debounce travels only as job metadata (`debounceId`/`debounceTtl`) and is not enforced anywhere server-side.
- Worker-level event emission — `on`/`once`/`off` forward straight to `Worker` ([Webhooks, Events & Job Logs](./webhooks-and-events.md)).
- Validation of the options it forwards to the `Queue`/`Worker` (`concurrency`, `heartbeatInterval`, `batchSize`, `pollTimeout`, `limiter`/`rateLimit`, `connection`, `autoBatch`, `defaultJobOptions`, `dlq`): those follow the `Queue`/`Worker` rules.

## Dependencies

Internal:

- [`Queue`](./client-queue-sdk.md) (`src/client/queue/queue.ts`) and [`Worker`](./client-worker-sdk.md) (`src/client/worker/worker.ts`) — the two objects constructed in the ctor.
- `Queue.upsertJobScheduler` / `getJobSchedulers` / `removeJobScheduler` for cron ([Scheduler & Cron](./scheduler-and-cron.md)).
- `Queue.changeJobPriority`, `Queue.getWaitingAsync`, `Queue.getJobsAsync({ state: 'prioritized' })` for priority aging (`src/client/bunqueue/aging.ts:65-92`).
- `Queue.setDlqConfig/getDlq/retryDlq/purgeDlq` and `setGlobalRateLimit/removeGlobalRateLimit` via `DlqRateLimitManager`.
- Types from the focused modules under `src/client/types/` (`job.ts`, `options.ts`, `worker.ts`, and `dlq.ts`; re-exported by `index.ts`).
- [Shared Timers & Durations](./shared-timers.md) (`src/shared/timers.ts`, `src/shared/durations.ts`): `safeTimeout` arms retry backoff, the circuit reset, the batch flush and the cancel grace; `safeInterval` arms the aging tick; `assertDuration` validates durations.

External/runtime:

- `AbortController` / `AbortSignal` (Web standard, Bun-native) for cancellation (`src/client/bunqueue/cancellation.ts`).
- Runtime timers, only through the shared helpers: a delay that fits the native range (0..2^31 - 1 ms) is one native timer, with nothing added on the per-batch or per-retry path; a longer one is armed in chunks and is never early. Retry backoff is bound to the job's `AbortSignal`; cancellation or `close()` clears the pending timer before it can invoke the processor again. No external npm dependencies.

## Public Interface

Exported class (`src/client/bunqueue.ts:25`):

```typescript
class Bunqueue<T = unknown, R = unknown> {
  readonly name: string;
  readonly queue: Queue<T>;
  readonly worker: Worker<T, R>;

  constructor(name: string, opts: BunqueueOptions<T, R>); // throws TypeError/RangeError for an invalid option

  use(middleware: BunqueueMiddleware<T, R>): this;

  add(name: string, data: T, opts?: JobOptions): Promise<Job<T>>;
  addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>): Promise<Job<T>[]>;
  getJob(id: string): Promise<Job<T> | null>;
  getJobCounts(); getJobCountsAsync(); count(); countAsync();

  cron(id: string, pattern: string, data?: T, opts?: { timezone?: string; limit?: number; jobOpts?: JobOptions }): Promise<SchedulerInfo | null>;
  every(id: string, intervalMs: number, data?: T, opts?: { limit?: number; jobOpts?: JobOptions }): Promise<SchedulerInfo | null>;
  removeCron(id: string); listCrons();

  cancel(jobId: string, gracePeriodMs?: number): void; // <= 0 cancels at once; throws for NaN, Infinity, a non-number
  isCancelled(jobId: string): boolean;
  getSignal(jobId: string): AbortSignal | null;

  getCircuitState(): CircuitState; resetCircuit(): void;

  trigger(rule: TriggerRule<T>): this;

  setDefaultTtl(ttlMs: number): void; setNameTtl(name: string, ttlMs: number): void;

  setDlqConfig(config: Partial<DlqConfig>): void;
  setDlqConfigAsync(config: Partial<DlqConfig>): Promise<void>;
  getDlqConfig(): DlqConfig; getDlqConfigAsync(): Promise<DlqConfig>;
  getDlq(filter?: DlqFilter): DlqEntry<T>[];
  getDlqAsync(filter?: DlqFilter): Promise<DlqEntry<T>[]>;
  getDlqStats(): DlqStats; getDlqStatsAsync(): Promise<DlqStats>;
  retryDlq(id?: string); retryDlqAsync(id?: string): Promise<number>;
  purgeDlq(); purgeDlqAsync(): Promise<number>;

  setGlobalRateLimit(max: number, duration?: number): void;
  setGlobalRateLimitAsync(max: number, duration?: number): Promise<void>;
  removeGlobalRateLimit(): void; removeGlobalRateLimitAsync(): Promise<void>;

  on(event, listener): this; once(event, listener): this; off(event, listener): this;

  pause(): void; pauseAsync(): Promise<void>;
  resume(): void; resumeAsync(): Promise<void>;
  close(force?: boolean): Promise<void>;
  isRunning(): boolean; isPaused(): boolean; isClosed(): boolean;
}
```

Middleware type (`src/client/bunqueue/types.ts:16-19`):

```typescript
type BunqueueMiddleware<T, R> = (job: Job<T>, next: () => Promise<R>) => Promise<R>;
```

Events (forwarded to `Worker`, `src/client/bunqueue.ts:196-219`): `ready`, `drained`, `closed`, `active`, `completed`, `failed`, `progress`, `stalled`, `error`. `once` is typed for `ready`/`drained`/`closed`/`completed`/`failed`. Besides the Worker's own errors, `error` receives the failures of the fire-and-forget commands of this instance's `Queue` and of trigger enqueues, as `BackgroundCommandError`s (see "Background command failures" below).

The synchronous DLQ query methods are embedded snapshots. Over TCP, use their
`Async` companions for authoritative values. Likewise, the async DLQ/rate-limit
mutations and `pauseAsync`/`resumeAsync` resolve only after broker
acknowledgement and return server counts where applicable; the legacy mutation
forms remain fire-and-forget compatible, and their failures are reported, never
left as unhandled rejections (see "Background command failures" below).

No TCP commands, HTTP endpoints, or CLI commands are defined here — those belong to [TCP Server Handlers](./tcp-server-handlers.md), [HTTP API](./http-api.md), and the [CLI](./cli.md). `add`/`cron`/etc. translate to the same `Queue` calls those layers expose.

## Data Models

All option shapes live in `src/client/bunqueue/types.ts`. See [data-model](../data-model.md) for `Job`/`JobOptions`/`DlqEntry`.

`BunqueueOptions<T, R>` (`types.ts:151-187`) — superset of `QueueOptions` + `WorkerOptions` knobs plus feature configs:

- Mode (exactly one): `processor?: Processor<T,R>`, `routes?: Record<string, Processor<T,R>>`, `batch?: BatchConfig<T,R>`.
- Connection/transport: `connection`, `embedded`, `dataPath`, `prefixKey` (forwarded to both Queue and Worker), `autoBatch`, `defaultJobOptions`.
- Worker tuning: `concurrency`, `autorun`, `heartbeatInterval`, `batchSize`, `pollTimeout`, `rateLimit`/`limiter`, `removeOnComplete`, `removeOnFail`.
- Feature configs: `retry?: RetryConfig`, `circuitBreaker?: CircuitBreakerConfig`, `ttl?: JobTtlConfig`, `priorityAging?: PriorityAgingConfig`, `deduplication?: BunqueueDeduplicationConfig`, `debounce?: BunqueueDebounceConfig`, `dlq?: BunqueueDlqConfig`.

`RetryConfig` (`types.ts:29-47`): `maxAttempts?` (3), `delay?` (1000), `strategy?` (`'exponential'`), `customBackoff?(attempt, error)`, `retryIf?(error, attempt)`.

`CircuitBreakerConfig` (`types.ts:50-64`): `threshold?` (5), `resetTimeout?` (30000), `onOpen?(failures)`, `onClose?()`, `onHalfOpen?()`. `CircuitState = 'closed' | 'open' | 'half-open'`.

`TriggerRule<T>` (`types.ts:70-83`): `on` (source job name), `event?` (`'completed'` default | `'failed'`), `create` (new job name), `data(result, job) => T`, `opts?`, `condition?(result, job) => boolean`.

`PriorityAgingConfig` (`types.ts:86-97`): `interval?` (60000), `minAge?` (60000), `boost?` (1), `maxPriority?` (100), `maxScan?` (100).

`BatchConfig<T,R>` (`types.ts:103-110`): `size` (required), `timeout?` (5000), `processor: (jobs: Job<T>[]) => Promise<R[]>`.

`JobTtlConfig` (`types.ts:113-118`): `defaultTtl?` (0 = off), `perName?: Record<string, number>`.

`BunqueueDeduplicationConfig` (`types.ts:121-128`): `ttl?` (3600000), `extend?`, `replace?`.
`BunqueueDebounceConfig` (`types.ts:131-134`): `ttl` (required).
`BunqueueDlqConfig` (`types.ts:137-148`): `autoRetry?`, `autoRetryInterval?` (3600000), `maxAutoRetries?` (3), `maxAge?` (604800000), `maxEntries?` (10000).

## Option validation

`resolveBunqueueFeatures` (`validation.ts`) runs in the constructor right after the mode check (`runtime.ts:47`), before the `Queue` and `Worker` are created, so a rejected option leaves no worker polling and nothing to close. It returns normalized copies of `retry`, `circuitBreaker`, `batch` and `priorityAging`, which the runtime uses instead of the caller's objects (a later change to those objects has no effect). Options forwarded to the `Worker` are validated by the `Worker` constructor; if it (or anything after it in the constructor) throws, the constructor stops the `Worker` if it exists and closes the `Queue`, releasing its reference on a shared TCP pool, before rethrowing (`runtime.ts:88-94`). `undefined` and `null` mean "use the default", as before. An invalid value throws a `TypeError` (wrong type) or a `RangeError` (out of range) whose message names the option and the value, for example `Bunqueue: priorityAging.interval must be a finite number of milliseconds >= 1 (got NaN)`. Durations go through the shared `assertDuration` and counts through `assertInteger` (a safe integer: `2 ** 53` is rejected as `not a safe integer`); the received value is shown by the shared `describeValue` (`-0` stays `-0`, a bigint keeps its `n`), the same as the legacy SDK port (`sdk/typescript/src/bunqueue/validation.ts`).

Values 2.9.10 read with a well-defined result are normalized to that result instead of rejected, so code that worked on 2.9.10 keeps working. The decisions are the legacy entry's (`sdk/typescript/src/bunqueue/validation.ts`), so both TypeScript entries agree:

- A numeric string (plain decimal digits) is that number (`tcp/numeric.ts`).
- `retry.maxAttempts`, `circuitBreaker.threshold` and `batch.size` are compared with `>=` (`attempt >= maxAttempts`, `failures >= threshold`, `buffer.length >= size`), so a value below 1 (0, a negative number) behaves exactly like 1 and a fraction like the next whole number; they are stored that way (2.5 → 3). NaN, which no `>=` reaches, a count above `Number.MAX_SAFE_INTEGER` and an omitted `batch.size` are no limit (`Infinity`): retry until success, `cancel()` or `close()`; never open; flush on `timeout` only.
- A one-shot delay (`retry.delay`, `circuitBreaker.resetTimeout`, `batch.timeout`) that is negative or NaN is 0: 2.9.10's timer ran it on the next tick. A negative `priorityAging.minAge` is 0 (every job passed `age >= minAge`); NaN or `Infinity` ages no job.
- An unknown `retry.strategy` (e.g. `'linear'`) runs as a fixed delay, the 2.9.10 result (`calculateBackoff`'s default branch), and the constructor logs one `console.warn` naming the value and the known strategies.
- A falsy `retry.customBackoff` or `retry.retryIf` (`false`, `0`) is ignored, as 2.9.10's truthiness checks did. A truthy non-function is rejected only where it would be called: `retryIf` always, `customBackoff` with `strategy: 'custom'` (2.9.10 failed every retry decision with `... is not a function`).
- A `customBackoff` result that is negative, NaN, `undefined` or `null` retries at once and a numeric string waits that many ms (`retry.ts`, `customDelay`); `Infinity` (2.9.10 retried after ~1 ms) or another non-number fails the attempt loop with an error whose `cause` is the processor error.
- `priorityAging.boost` is any number but NaN (0 never ages, a negative boost lowers priorities, as on 2.9.10), `maxPriority` any number (`Infinity` = no cap; NaN never boosts), and `maxScan` any number but `Infinity` (which crashed 2.9.10's tick).
- `cancel(jobId, gracePeriodMs)` with a negative grace or NaN cancels at once, as `0` does; a numeric string is a grace period.

| Option | Accepted | `Infinity` |
| ------ | -------- | ---------- |
| `retry.maxAttempts` | any number (below 1 = 1, fractions round up, NaN = no limit) | accepted: retry until success, `cancel()` or `close()` |
| `retry.delay` | finite number of ms (negative or NaN = 0) | rejected |
| `retry.strategy` | `fixed`, `exponential`, `jitter`, `fibonacci`, `custom`; anything else runs as `fixed` with a warning | — |
| `retry.customBackoff`, `retry.retryIf` | functions; falsy = absent; a non-function only where unused | — |
| `circuitBreaker.threshold` | any number (below 1 = 1, fractions round up, NaN = never opens) | accepted: the circuit never opens |
| `circuitBreaker.resetTimeout` | finite number of ms (negative or NaN = 0) | accepted: stays open until `resetCircuit()` |
| `batch.size` | any number (below 1 = 1, fractions round up); omitted or NaN = flush on `timeout` only | accepted: flush on `timeout` or `close()` only |
| `batch.timeout` | finite number of ms (negative or NaN = 0) | rejected |
| `priorityAging.interval` | finite number of ms >= 1 | rejected |
| `priorityAging.minAge` | any number (negative = 0; NaN = no job ages) | accepted: no job ages |
| `priorityAging.boost` | any number but NaN | accepted |
| `priorityAging.maxPriority` | any number | accepted: no cap |
| `priorityAging.maxScan` | any finite number | rejected |
| `cancel(jobId, gracePeriodMs)` | finite number of ms (negative or NaN = 0); omitted, `undefined` or `null` = 0 | rejected |

Why these bounds:

- A runtime timer rewrites NaN, ±Infinity, negative delays and delays above 2^31 - 1 ms to about 1 ms, and an interval of 0 or less spins; these values used to turn a misconfiguration into a hot loop (a NaN aging interval ran two job queries about 870 times a second). Finite values above the limit are valid and honoured exactly.
- `priorityAging.interval >= 1`: the runtime rounds a shorter period up to 1 ms, so 1 ms is the smallest period that means what it says.
- A NaN `priorityAging.boost` wrote NaN priorities into embedded queues, so it is rejected; other boosts keep their 2.9.10 effect (0 never ages, a negative one lowers priorities).
- `priorityAging.maxScan` finite: it bounds the work of every tick (two queries and up to one priority update per job found); `Infinity` crashed 2.9.10's tick.
- `Infinity` is accepted only where it is a useful "no limit" whose cost stays bounded: retries are paced by the backoff, a batch is bounded by worker `concurrency` and its `timeout`, and an open circuit holds no work. It is rejected for `batch.timeout` (a partial batch would hold its worker slots until `close()`), `retry.delay` (the job would stay active forever), the aging interval and the cancel grace (omit the option, or do not call `cancel()`); 2.9.10 ran each of those after ~1 ms instead.
- `cancel()` validates on every call, including for an unknown or finished job id, so a bad grace period fails where it is computed.

Not validated here, because they reach no timer or loop bound: `ttl.defaultTtl`, `ttl.perName`, `setDefaultTtl()` and `setNameTtl()` only feed the expiry comparison (a TTL `<= 0`, or NaN, disables expiry for that job name).

## Business Logic / Control Flow

**Construction** (`src/client/bunqueue/runtime.ts:39-88`):

1. Reject legacy flat connection options and validate the mode count: error if zero or more than one of `processor`/`routes`/`batch` is set (`:40-43`).
2. Validate the feature options ([Option validation](#option-validation), `:45`) and keep a copy of `retry` (`:49`), so the validated settings cannot be changed later through the caller's object.
3. Build `baseProcessor`: if `batch`, create a `BatchAccumulator` and use its buffering processor; else use the `routes`-derived dispatcher or the raw `processor` (`:53-61`). The route dispatcher looks up `routeMap[job.name]` and throws `No route for job "<name>" in queue "<queue.name>"` if missing (`:90-97`).
4. Wrap the base processor so the `Worker` always calls `processJob(job)` (`:63`).
5. Construct the `Queue` (`:64`), then the `Worker` (`:68`), which validates the options forwarded to it, using the focused option builders at `:99-125`.
6. Route the `Queue`'s background command failures to the `Worker`'s `error` event (`setBackgroundErrorListener(queue, errorEventListener(worker))`, before `options.dlq` sends its `SetDlqConfig`), then instantiate `DlqRateLimitManager` (apply `options.dlq` if present), `WorkerCircuitBreaker` (only if `options.circuitBreaker`), `TriggerManager`, and `PriorityAger` (started immediately if `options.priorityAging`) (`:70-87`). The batch accumulator, the breaker and the ager resolve their defaults once, at construction.
7. If step 5 or 6 throws, roll back: stop the `Worker` if it was created (`close(true)`, best-effort), close the `Queue`, and rethrow (`:88-94`).

**Per-job pipeline** (`processJob`, `src/client/bunqueue/runtime.ts:127-161`), in order:

1. If circuit breaker `isOpen()` → reject with `Circuit breaker is open` (`:128`).
2. If `TtlChecker.isExpired(job.name, job.timestamp)` → reject with `Job expired (age: …ms)` (`:129-131`). Expiry compares `Date.now() - jobTimestamp > ttl` (`ttl.ts:21-25`); creation timestamp is used, so the gate fires only when the job is actually pulled, not proactively.
3. Register an `AbortController` for `job.id` (`:133`, `cancellation.ts:24-30`).
4. Build `runChain = () => runMiddlewareChain(job, abortController)`. If `retryConfig` is set, wrap in `executeWithRetry`; otherwise call `runChain()` once (`:134-139`).
5. Synchronous processor or middleware throws are normalized into the same rejected execution path. On resolve → notify the circuit breaker, return the result, and unregister the exact cancellation generation in `finally`. On reject → notify the circuit breaker, rethrow, and unregister that same generation in `finally` (`:140-160`). An older execution settling after a redelivery cannot remove the newer execution's controller, and neither a synchronous throw nor a throwing user circuit-breaker hook can leave an unreachable registration behind. After `close()` destroys the breaker, these outcome notifications are terminal no-ops; ordinary explicit cancellation preserves the existing cooperative outcome semantics.

**Middleware onion** (`runMiddlewareChain`, `src/client/bunqueue/runtime.ts:163-185`): with zero middlewares, the base processor runs directly. Otherwise `next()` walks `middlewares[0..n)` then the base processor, forming `mw1 → mw2 → … → base → … → mw2 → mw1`. Before each step `next()` checks `abortController.signal.aborted` and rejects with `Job cancelled` (`:177`).

**In-process retry** (`executeWithRetry`, `retry.ts:124-153`): re-invokes the chain up to `maxAttempts`. Synchronous throws and rejected Promises enter the same path. On failure, if `retryIf` returns false it rethrows immediately; otherwise it waits `calculateBackoff(...)` and retries. The wait (`waitForRetry`, `retry.ts:95-121`) is a `safeTimeout` that owns an abort listener for the current execution: abort clears the timer, removes the listener, rejects the retry, and cannot invoke the chain again. Backoff strategies (`calculateBackoff`, `retry.ts:58-89`): `fixed`, `exponential` (`base·2^(n-1)`), `jitter` (`exp·(0.5+random)`, factor 0.5-1.5), `fibonacci` (base times the sequence 1, 2, 3, 5, 8, … for attempts 1, 2, 3, …), `custom` (`customBackoff(attempt, error)`, falls back to base if absent).

- **Any computed delay is honoured exactly.** With the 1000 ms default base, `exponential` passes the 2^31 - 1 ms native limit at attempt 23, `jitter` at attempt 22 and `fibonacci` at attempt 31; those waits are armed in chunks, not rewritten to about 1 ms.
- **The arithmetic cannot overflow.** Below the saturation point every strategy follows its formula exactly. Growth saturates at `MAX_RETRY_DELAY_MS` (`Number.MAX_SAFE_INTEGER` ms, about 285,000 years) instead of reaching Infinity, a zero base stays 0 (rather than `0 × Infinity = NaN`), and the fibonacci loop stops once the delay saturates, so it is bounded for any attempt number.
- **No backoff cap, by design.** Queue-level `backoff` is capped at `DEFAULT_MAX_BACKOFF` (1 h) unless `backoff.maxDelay` is set ([Job Lifecycle](./job-lifecycle.md)). Simple Mode's formulas are documented without a cap and have no `maxDelay` option, and capping them would retry earlier than documented, so they are honoured as written. To bound growth, use `customBackoff` (for example `Math.min(...)`) or a smaller `maxAttempts`.
- **`customBackoff` contract** (`customDelay`, `retry.ts:43-55`): the result must be a finite number of milliseconds >= 0. Anything else (NaN, ±Infinity, a negative number, a non-number) rejects the execution with a `TypeError` or `RangeError` (`Bunqueue: the delay returned by retry.customBackoff must be a finite number of milliseconds >= 0 (got NaN)`) whose `cause` is the processor error; no retry is scheduled, and the job then fails through normal `Worker` handling. An exception thrown by `customBackoff` itself propagates unchanged.
- **`maxAttempts: Infinity`** retries until success, `cancel()` or `close()`. Each retry waits its backoff, so pair it with a non-zero `delay`: a zero delay retries as fast as the event loop allows.

**Circuit breaker** (`circuitBreaker.ts`): `onFailure` increments a consecutive-failure counter; once `failures >= threshold` (or any failure while `half-open`) it calls `open()`. `open()` sets state `open`, fires `onOpen`, **pauses the Worker**, and schedules one identity-checked `safeTimeout(resetTimeout)` that flips to `half-open`, fires `onHalfOpen`, and **resumes the Worker**. A reset longer than about 24.8 days half-opens when it elapses; `resetTimeout: Infinity` arms nothing, so the circuit stays open until `resetCircuit()`. The next success in `half-open` closes the circuit. `reset()` clears state/timer and resumes the worker if paused. `destroy()` is terminal: it clears the owned timer and makes stale outcome callbacks and reset callbacks no-ops.

**Batch mode** (`batch.ts`): the buffering processor pushes `{job, resolve, reject}` and flushes when `buffer.length >= size`, else arms one `safeTimeout(timeout)` for the partial batch (`:35-47`). A timeout in the native range is one native timer, so the per-batch cost is unchanged; a longer one is armed in chunks. `flush()` splices the buffer, calls the user `processor(jobs)`, and resolves each entry with `results[i]` positionally (`undefined` if the array is shorter) or rejects all on error (`:53-76`).

**Graceful cancellation** (`cancellation.ts`, `bunqueue.ts:98-101`): `cancel()` validates the grace period, then a grace of 0 clears any pending timer and aborts at once; a positive grace arms one `safeTimeout(grace)` per execution. Deadlines are compared on the monotonic clock that `safeTimeout` uses (`performance.now()`), so repeated calls keep the earliest deadline even if the wall clock moves.

**Triggers** (`triggers.ts`): the first `trigger()` lazily subscribes to the worker's `completed`/`failed` events (`:34-45`). On fire, every rule whose `on === job.name`, whose `event` matches, and whose `condition` passes enqueues `queue.add(rule.create, rule.data(...), rule.opts)` (`:47-56`). The add is not awaited: it goes through `runInBackground` (`src/client/queue/backgroundCommand.ts`), so a rejected enqueue is reported as an `add` failure for the queue (prefix included) instead of becoming an unhandled rejection.

**Priority aging** (`aging.ts`): every `interval` (a `safeInterval`, `:42-46`), start a tick unless one is still in flight (`runTick`, `:55-63`). A tick fetches up to `maxScan` waiting + prioritized jobs and, for each with `age >= minAge` and `priority < maxPriority`, calls `changeJobPriority` to `min(priority + boost, maxPriority)` (`:65-92`). At most one tick runs at a time, across generations: a firing that finds the previous tick still waiting on its queries or updates is dropped, not queued, so a slow tick cannot overlap the next one (which would re-read and boost the same jobs again) and the dropped firings do not burst once it settles; the next tick starts on the next firing. It is best-effort: `changeJobPriority` failures are swallowed, and a tick whose job queries reject is skipped (the next tick retries) instead of surfacing as an unhandled rejection, which would terminate a Node.js process by default. `start()` is idempotent, `destroy()` invalidates queued/awaiting callbacks before clearing the interval, and a later `start()` creates a fresh generation.

**Dedup/debounce merge** (`dedupDebounce.ts`): on every `add`/`addBulk`, if configured and the caller did not already set `deduplication`/`debounce`, inject `deduplication.id = \`${name}:${JSON.stringify(data)}\`` (ttl default 3600000) and/or `debounce = { id: name, ttl }` (`:21-40`).

**Shutdown** (`close`, `src/client/bunqueue.ts:241-248`): destroy the priority ager (invalidates and clears its interval), terminally destroy the circuit breaker (clears its timer and rejects later outcome notifications), destroy the batch accumulator (`destroy()` flushes any remaining buffered jobs, `batch.ts:78-87`), clear graceful-cancellation timers and abort all registered controllers, then `worker.close(force)` and `queue.close()`. Aborting a retry during this sequence cannot invoke the processor or reopen the breaker. Every timer above is cleared, however long its delay, so none keeps the process alive after `close()`.

## Concurrency & Locking

This module holds no shard locks; all locking happens inside `Queue`/`Worker`/`QueueManager` ([Concurrency & Locking](./concurrency-and-locking.md)). Local concurrency concerns:

- The `Worker`'s `concurrency` determines how many `processJob` invocations run in parallel. Batch mode relies on this: a batch only fills to `size` if at least `size` jobs are processed concurrently, otherwise the `timeout` flush is what closes a partial batch. With `concurrency` below `batch.size`, batches are bounded by `timeout`.
- `WorkerCircuitBreaker` mutates shared `state`/`failures` from `onSuccess`/`onFailure` callbacks driven by concurrent job completions; these run on the single JS event loop, so updates are serialized (no atomics needed), but the failure counter is consecutive-style and a burst of concurrent failures all increment it before `open()` pauses the worker.
- Cancellation exposes the current controller by `job.id` and also tracks each execution by controller identity. Resolve/reject cleanup therefore removes only its own generation. A delayed cancel owns at most one timer per execution.
- Aging runs at most one tick at a time (`PriorityAger.inFlight`). When job queries or priority updates take longer than `interval` (a short interval over a slow link), the firings that land during the tick are dropped: a job is boosted at most once per completed tick, and boosts arrive less often than `interval` rather than in a burst. A tick still pending a call after `destroy()` blocks the ticks of a later `start()` until that call settles; it begins no new priority change.

## Edge Cases & Failure Modes

- **Two independent retry layers.** `RetryConfig` retries the processor **in-process** (same pull, same job, no requeue) and is entirely separate from the queue-level `JobOptions.attempts`/`backoff`. A job can be retried `maxAttempts` times inside one `processJob`, and only if it still throws does the `Worker` mark it failed (which may then trigger queue-level retry/DLQ). Total attempts multiply.
- **Durations beyond 24.8 days are honoured.** A batch timeout, circuit reset, cancel grace, retry backoff or aging interval longer than the native 2^31 - 1 ms limit waits its full length, never about 1 ms. A job that waits a long retry backoff stays active (holding its worker slot) for that long; `cancel()` and `close()` end the wait.
- **Cancellation is cooperative once processor code is running.** The signal is checked before the base processor and at each middleware `next()` boundary. A processor already executing must still read `getSignal(jobId)` itself to stop its own asynchronous work. The controller is registered immediately before processor execution, so callers that must cancel a newly added job should wait for the Worker's `active` event; a fixed delay after `add()` races the polling interval. `cancel()` on an unknown, not-yet-active, or finished job id is a no-op (after the grace period is validated). Repeated graceful cancels retain the earliest deadline; a shorter grace period advances it, a longer one cannot postpone it, and an immediate cancel clears the pending timer before aborting. Completion and `close()` clear every remaining grace and retry timer.
- **TTL rejects, it does not delete.** An expired job is rejected at processing time and flows through normal `Worker` failure handling (retry/DLQ); it is not silently dropped, and a job that is never pulled is never expired.
- **Circuit open pauses the whole worker.** While open, no jobs of any name are processed until `resetTimeout` elapses (never, for `Infinity`, until `resetCircuit()`). A single failure during `half-open` re-opens immediately.
- **Route miss throws.** Unrouted job names throw synchronously inside the processor and become job failures, not silent drops (`runtime.ts:90-97`).
- **Batch result alignment is positional.** If the batch `processor` returns fewer results than jobs (or reorders), jobs receive the wrong/`undefined` result; a thrown error rejects every job in the batch. Buffered-but-not-flushed jobs are flushed on `close()`, but jobs still in the worker's poll loop are not part of `BatchAccumulator`.
- **Dedup default key uses `JSON.stringify(data)`.** Non-deterministic key ordering or unstringifiable data affects the dedup id. The injected debounce id is just the job `name`, but note that `debounce` is currently metadata-only: the server stores `debounceId`/`debounceTtl` on the job and returns them in job views, with no suppression logic attached.
- **Background command failures.** The synchronous mutators (`pause`/`resume`, `setDlqConfig`, `retryDlq`, `purgeDlq`, `setGlobalRateLimit`/`removeGlobalRateLimit`, the `dlq` option at construction) and trigger enqueues are not awaited. A failure (broker unreachable, `Command timeout` after `commandTimeout`, a call after `close()`) is emitted on `error` as a `BackgroundCommandError` (`context: 'background-command'`, `command` such as `SetDlqConfig`, `RateLimit`, `Pause` or `add`, `queue`, `cause`) while an `error` listener is attached, checked when the failure arrives, so a listener attached after the constructor still receives the `dlq` option's failure. Without a listener, or if the listener throws, it is logged as one `console.error` line `[bunqueue] <command> for queue "<queue>" failed in the background: <reason>`. A command still pending when `close()` runs is not reported. Use the `Async` forms when the caller needs the outcome. Triggers only attach after the first `trigger()` call.
- **Priority aging is best-effort.** `changeJobPriority` failures are swallowed, a tick whose job queries fail is skipped, and a firing that lands while the previous tick is still running is dropped; aging only scans the first `maxScan` waiting + prioritized jobs per tick, so deep backlogs age slowly. A tick invalidated by `destroy()` cannot begin new priority changes after its awaited query returns.
- **Pause/resume act on both** the queue and the worker. `pauseAsync()` and
  `resumeAsync()` await the queue-side transition before changing the local
  worker; the synchronous forms retain fire-and-forget TCP behavior, with a
  failure reported as above. The
  circuit breaker calls `worker.pause()/resume()` directly, so an
  externally-paused worker can be resumed by a circuit half-open transition.

## Configuration

Behavior is configured entirely through `BunqueueOptions` (no env vars are read in this module). Transport-related env vars are honored by the underlying `Queue`/`Worker` ([Configuration & Entrypoint](./configuration.md)). Defaults (from `src/client/bunqueue/types.ts`; accepted values in [Option validation](#option-validation)):

| Option | Default |
| ------ | ------- |
| `retry.maxAttempts` / `delay` / `strategy` | 3 / 1000ms / `exponential` |
| `circuitBreaker.threshold` / `resetTimeout` | 5 / 30000ms |
| `priorityAging.interval` / `minAge` / `boost` / `maxPriority` / `maxScan` | 60000 / 60000 / 1 / 100 / 100 |
| `batch.size` / `timeout` | required / 5000ms |
| `ttl.defaultTtl` | 0 (disabled) |
| `deduplication.ttl` | 3600000ms |
| `dlq.autoRetryInterval` / `maxAutoRetries` / `maxAge` / `maxEntries` | 3600000 / 3 / 604800000 / 10000 |
| `concurrency`, `heartbeatInterval`, `batchSize`, `pollTimeout` | inherited from `Worker` defaults |

`prefixKey` namespaces the queue name on the broker and is forwarded to both the `Queue` and the `Worker`, isolating jobs, workers, cron schedulers, stats, and DLQ between environments.

## Tests

- `test/bunqueue.test.ts`: the end-to-end feature suite (routes, middleware, cron, batch, retry, cancellation, circuit breaker, triggers, TTL, aging, dedup/debounce, rate limit, DLQ).
- `test/repro-bunqueue-timer-overflow.test.ts`: batch timeout, cancel grace, circuit reset and aging interval beyond the timer limit, on the fake runtime of `test/shared-timers-support.ts` (no native timer receives an out-of-range delay; each waits exactly its delay), plus the contained aging-tick failure.
- `test/repro-bunqueue-aging-overlap.test.ts`: aging queries or updates slower than the interval: one tick in flight, one boost per job per tick, no burst afterwards, and a stale tick across `destroy()`/`start()`.
- `test/repro-bunqueue-retry-backoff.test.ts`: every strategy past its overflow attempt, saturation, the zero base, and the `customBackoff` contract.
- `test/repro-bunqueue-option-validation.test.ts`: every rejected and accepted option value, the `cancel()` grace period, and validation before any `Queue`/`Worker` exists.
- `test/repro-bunqueue-construction-cleanup.test.ts`: a `Worker` that rejects a forwarded option releases the `Queue`'s shared TCP pool reference, and a failure after the `Worker` started stops it.
- `test/repro-bunqueue-long-durations.test.ts`: 30-day durations in a fresh Bun process (no `Timeout*Warning`, nothing fires early, `close()` lets the process exit).
- `test/repro-bunqueue-sync-throw-cancellation.test.ts`, `test/repro-timer-lifecycle-idempotency.test.ts`: cancellation cleanup and timer ownership.

## Related Docs

- [Client SDK: Queue](./client-queue-sdk.md) · [Client SDK: Worker](./client-worker-sdk.md)
- [Shared Timers & Durations](./shared-timers.md)
- [Scheduler & Cron](./scheduler-and-cron.md) · [Dead Letter Queue](./dead-letter-queue.md) · [Rate Limiting & Concurrency](./rate-limiting-and-concurrency.md)
- [Deduplication & Unique Jobs](./deduplication-and-unique.md) · [Webhooks, Events & Job Logs](./webhooks-and-events.md)
- [Job Lifecycle](./job-lifecycle.md) · [Core Queue Engine](./core-queue-engine.md) · [Workflow Engine](./workflow-engine.md)
- [architecture](../architecture.md) · [data-model](../data-model.md)
