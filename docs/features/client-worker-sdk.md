# Client SDK: Worker (& sandboxed)

> **Category:** Client SDK · **Source:** `src/client/worker/worker.ts`, `src/client/worker/runtime/`, `src/client/worker/types/`, `src/client/worker/handlers/`, `src/client/worker/processor.ts`, `src/client/worker/processorOutcome.ts`, `src/client/worker/processorResult.ts`, `src/client/worker/batchExecution.ts`, `src/client/worker/ackBatcher.ts`, `src/client/worker/ackFrontier.ts`, `src/client/worker/workerPull.ts`, `src/client/worker/pullFailureLog.ts`, `src/client/worker/workerHeartbeat.ts`, `src/domain/job/timeoutRule.ts` (shared with the broker), `src/client/queue-events/tcpSubscription.ts`, `src/client/sandboxed/worker.ts`, `src/client/sandboxed/runtime/`, `src/client/sandboxed/types/`, `src/client/sandboxed/wrapper.ts`, `src/client/sandboxed/queueOps.ts`

## Purpose

The Worker SDK is the consumer side of bunqueue: a BullMQ-style polling worker that pulls jobs, runs a processor, and reports the outcome to the broker. The four-line `Worker` façade inherits focused state, control, manual-processing, lifecycle, buffer, polling and execution layers under `worker/runtime/`; its contracts live under `worker/types/`. `SandboxedWorker` follows the same four-line façade pattern with state, lifecycle, pool, dispatch and recovery modules (plus the `options` validation and `thread` event helpers) under `sandboxed/runtime/` and separate types under `sandboxed/types/`. Both embedded and TCP transports use the same public API.

## Responsibilities & Scope

Owns:

- Job pull loop, concurrency gate, batch pulling, long-poll and pull-error backoff (`runtime/polling.ts`).
- Lease accounting and buffered-job selection (`runtime/state.ts`, `runtime/buffer.ts`, `runtime/execution.ts`).
- Processor invocation, auto-ack on success, fail/retry dispatch,
  `DelayedError`/`UnrecoverableError` handling, and processor-owned terminal or
  nonterminal transitions (`processor.ts`, `processorOutcome.ts`).
- One-invocation native batch processing with per-member outcomes
  (`batchExecution.ts`), structural Observable completion (`processorResult.ts`),
  and AbortSignal cancellation for active delivery generations.
- ACK batching with backpressure, retry, and a reachable-outcome frontier
  (`ackBatcher.ts`, `ackFrontier.ts`).
- Job and worker heartbeats / lock renewal (`workerHeartbeat.ts`,
  `runtime/control.ts`, `runtime/execution.ts`).
- Worker registration/unregistration with the server, and re-registration on
  reconnect (`runtime/state.ts`, `runtime/execution.ts`, `runtime/lifecycle.ts`).
- Queue-scoped `stalled` notification delivery from the manager in embedded
  mode or a dedicated broker event subscription in TCP mode.
- Client-side rate limiting and per-group concurrency (`workerRateLimiter.ts`, `groupConcurrency.ts`).
- Graceful/forced close and buffered-job release (`runtime/lifecycle.ts`).
- Sandboxed thread lifecycle, dispatch, timeout, crash restart and idle recycle (`sandboxed/runtime/`).

Does NOT own (delegated):

- Queue state, priority ordering, persistence, stall _detection itself_, lock storage — all server/`QueueManager` side. See [Core Queue Engine](./core-queue-engine.md), [Job Lifecycle](./job-lifecycle.md), [Persistence](./persistence.md).
- The TCP wire framing and connection pool/reconnect — see [Client Transport](./client-transport.md) and [TCP Wire Protocol](./tcp-protocol.md).
- Producing jobs — see [Client SDK: Queue](./client-queue-sdk.md).
- DLQ routing on max-attempts — see [Dead Letter Queue](./dead-letter-queue.md).

## Dependencies

Internal:

- `../manager` (`getSharedManager`) — embedded `QueueManager` access. Worker construction synchronously rejects an explicit `dataPath` that differs from the process-wide manager's canonical path; an omitted path joins the active manager. See [Client SDK: Queue](./client-queue-sdk.md) and [Core Queue Engine](./core-queue-engine.md).
- `../tcpPool` (`TcpConnectionPool`, `getSharedPool`/`releaseSharedPool`) — TCP transport. See [Client Transport](./client-transport.md).
- `./processor` + `./processorHandlers` — execution and the `Job` method handlers (progress/log/state/children/mutations).
- `./ackBatcher`, `./workerPull`, `./workerHeartbeat`, `./jobParser`.
- `../../domain/job/timeoutRule` (`processingTimeoutDelay`): the processing-timeout
  rule shared with the broker's timeout scheduler.
- `../job-wait/types` (`isTransientReply`, `isTransientError`): which pull failures pass
  with time, the same classification the job wait retries.
- `../../shared/lockError` (`LOCK_TIMEOUT_MESSAGES`, `LockTimeoutError`): the broker's
  lock-timeout replies, which a pull refusal also treats as transient, and the error an
  embedded pull throws for the same timeout, which a pull failure treats as transient.
- `./workerRateLimiter`, `./groupConcurrency`. See [Rate Limiting & Concurrency](./rate-limiting-and-concurrency.md).
- `../resolveToken`, `../types` (`WorkerOptions`, `Processor`, `Job`, `RateLimiterOptions`).
- `../../shared/timers` (`safeTimeout`, `safeInterval`) and `../../shared/durations`
  (`assertDuration`, `assertInteger`): every Worker timer, duration and count. See
  [Shared Timers & Durations](./shared-timers.md).

External / runtime:

- Bun APIs: `Worker` (sandboxed threads), `Bun.sleep`, `Bun.file`, `Bun.env`, `Bun.gc` indirectly via `smol`.
- Node `events.EventEmitter`, `os.hostname`, `node:fs`/`node:fs/promises`/`node:path` (sandboxed wrapper file generation).

## Public Interface

### `Worker<T, R>` (`worker/worker.ts`, `worker/runtime/`)

```typescript
class Worker<T = unknown, R = unknown> extends EventEmitter {
  constructor(name: string, processor: Processor<T, R>, opts?: WorkerOptions);

  run(): void;
  pause(): void;
  resume(): void;
  isRunning(): boolean;
  isPaused(): boolean;
  isClosed(): boolean;
  get concurrency(): number;
  set concurrency(val: number); // below 1 or null → 1, fraction rounds up, Infinity kept; bumps poll if raised
  get closing(): Promise<void> | null;
  waitUntilReady(): Promise<void>; // TCP: sends Ping; embedded: no-op

  // Manual job control
  getNextJob(token?: string, opts?: { block?: boolean }): Promise<ManualJob<T> | undefined>;
  processJobManually(job, token?, fetchNextCallback?): Promise<ManualJob<T> | undefined>;
  extendJobLocks(jobIds: string[], tokens: string[], duration: number): Promise<number>; // duration: finite, >= 1; null = the lease's own TTL

  // Cancellation (cooperative through the processor context signal)
  cancelJob(jobId: string, reason?: string): boolean;
  cancelAllJobs(reason?: string): void;
  isJobCancelled(jobId: string): boolean;

  // Rate limiter (delegated to WorkerRateLimiter)
  getRateLimiterInfo(): { current: number; max: number; duration: number } | null;
  rateLimit(expireTimeMs: number): void; // not a positive finite number (0, negative, NaN, Infinity, null) = no-op, as on 2.9.10
  isRateLimited(): boolean;
  rateLimitGroup(job: Job<T>, duration: number): Promise<void>;

  // BullMQ v5 compat
  startStalledCheckTimer(): Promise<void>; // no-op (stall detection is server-side)
  delay(ms?: number, abortController?: AbortController): Promise<void>; // ms finite; <= 0 resolves at once

  close(force?: boolean): Promise<void>;
}
```

### `SandboxedWorker<T>` (`sandboxed/worker.ts`, `sandboxed/runtime/`)

```typescript
class SandboxedWorker<T = unknown> extends EventEmitter {
  constructor(queueName: string, options: SandboxedWorkerOptions);
  start(): Promise<void>;
  stop(force?: boolean): Promise<void>;
  isRunning(): boolean;
  getStats(): { total: number; busy: number; idle: number; recycled: number; restarts: number };
}
```

Re-exported (with a `@deprecated` alias) from `src/client/sandboxedWorker.ts`.

### Helper modules

- `processJob(internalJob, ProcessorConfig)` (`processor.ts:60`).
- `AckBatcher` (`ackBatcher.ts:25`) with `queue/flush/stop/waitForInFlight/hasPending`.
- `pullEmbedded(config, count)` / `pullTcp(config, tcp, count, closing)` (`workerPull.ts`).
- `startHeartbeat(deps, intervalMs): SafeTimer` / `sendHeartbeat(deps)` (`workerHeartbeat.ts`).
- `parseJobFromResponse(jobData, queueName)` (`jobParser.ts`).
- `processingTimeoutDelay(job): number | null` (`src/domain/job/timeoutRule.ts`): the
  per-job processing timeout the broker enforces, as a delay from `startedAt` (see
  Processing & outcome).
- `PullRefusedError`, `isTransientRefusal(response)`, `isTransientPullError(error)`
  (`workerPull.ts`): a refused PULL/PULLB and the transient-failure classification (see
  Edge Cases).

### TCP commands sent (client → server)

`PULL`, `PULLB`; `ACKB` (batch ack), `FAIL`; `MoveToWait`, `MoveToDelayed`, `MoveToWaitingChildren`; `RateLimitGroup`; `JobHeartbeat`, `JobHeartbeatB`, `Heartbeat`; `RegisterWorker`, `UnregisterWorker`; `Ping`; `ExtendLock`, `ExtendLocks`; and `SubscribeEvents` on a dedicated queue-event connection (`UnsubscribeEvents` is available to raw protocol clients; Worker closes its dedicated socket). Processor `Job` handlers additionally send `Progress`, `AddLog`, `GetState`, `GetResult`, `GetChildrenValues`, `GetFailedChildrenValues`, `GetIgnoredChildrenFailures`, `RemoveChildDependency`, `RemoveJobDeduplicationKey`, `RemoveUnprocessedChildren`, `Cancel` (remove), `Update`, `Promote`, `ChangeDelay`, `ChangePriority`, `ClearLogs`, `Discard`, and for `waitUntilFinished` (the shared wait in `client/jobWait.ts`, see [Client SDK: Queue](./client-queue-sdk.md)) `GetState`, `GetResult`, `GetJob` for the failure reason, and `WaitJob` with its own command timeout. `SandboxedWorker` TCP ops also use plain `ACK` and `GetJobCounts`. See [TCP Server Command Handlers](./tcp-server-handlers.md).

### Events emitted

`Worker`: `ready`, `active(job)`, `completed(job, result)`, `failed(job,
error)`, `progress(job, n)`, `stalled(jobId, reason)` (embedded and TCP),
`error(err)`, `cancelled({jobId, reason})`,
`log(job, msg)`, `drained`, `closed` (`worker/runtime/state.ts`).
`SandboxedWorker`: `ready`, `active`, `completed`, `failed`, `progress`, `log`,
`error`, `closed` (no `drained` / `stalled` / `cancelled`)
(`sandboxed/runtime/state.ts`).

## Data Models

See [data-model](../data-model.md) for the full `Job` shape. Key types used here:

- `WorkerOptions`: `client/types/worker.ts`.
- `ExtendedWorkerOptions`: `client/worker/types/options.ts`, resolved by
  `worker/runtime/options.ts`.
- `Processor<T, R>`: `client/types/flow.ts`; processor-internal contracts:
  `client/worker/types/processor.ts`.
- `PendingAck`: `client/worker/types/transport.ts`.
- `SandboxedWorkerOptions`: `client/sandboxed/types/options.ts`.
- `WorkerProcess` (its `timeoutId` holds the per-job `SafeTimer`; `terminated`,
  `crashed` and `retired` track a slot's thread) and IPC requests/responses:
  `client/sandboxed/types/process.ts`.
- `jobParser` builds an `InternalJob` from a TCP response, defaulting `maxAttempts=3`, `backoff=1000`, `attempts=0`, etc. (`jobParser.ts`).
  It also reads the object-form `backoffConfig` (`{ type, delay, maxDelay? }`) that the
  server serializes with every pulled job, so `job.opts.backoff` and the
  `DelayedError` cap see `maxDelay` in TCP mode. A missing field, `null`
  (numeric backoff) or malformed object yields `null`; an unusable
  `maxDelay` is dropped through the same `parseMaxDelay` rule `createJob` uses.

## Business Logic / Control Flow

### Construction & startup

`resolveWorkerOptions` in `worker/runtime/options.ts` applies defaults:
`concurrency=1`, `autorun=true`, `heartbeatInterval=10000`,
`batchSize=min(opts,1000)` default 10, `pollTimeout=min(opts,30000)` default 0,
`useLocks=true`, `drainDelay=50`, `lockDuration=30000`,
`maxStalledCount=1`. It first calls `rejectLegacyConnectionOptions()`
(`client/legacyConnectionOptions.ts`): in TCP mode a defined top-level `host`,
`port`, `token`, or `tls` (the flat bunqueue-client 0.1.x shape, never read)
throws before any pool, timer, or subscription exists, naming the keys to move
into `connection`. `SandboxedWorker` runs the same guard unless an embedded
`manager` is injected, because without `connection` it would silently run
embedded. `worker/runtime/state.ts` owns
`queueKey = (prefixKey ?? '') + name`, transport construction, ACK-batcher
wiring, reconnect registration, and the `autorun` decision.

`resolveWorkerOptions` also validates the four duration options with
`assertDuration`, and `concurrency` and `batchSize` (`resolveWorkerConcurrency`,
`resolveBatchSize`, falling back to `assertInteger`; all from `src/shared/durations.ts`
or `options.ts`), before the rate limiter, ACK batcher, embedded manager or TCP pool
exists, so a bad value throws from the constructor and is never armed or sent.
`undefined` or `null` selects the default. A non-number throws a `TypeError`, anything
else out of range a `RangeError` naming the option, for example `Worker: heartbeatInterval
must be a finite number of milliseconds >= 1 (got 0.5)` or `Worker: concurrency must be a
number > 0 or Infinity (got 0)`.

Values 2.9.10 read with a well-defined result are normalized to that result instead of
rejected, so code that worked on 2.9.10 keeps working after an upgrade:

- a numeric string (plain decimal digits, e.g. `process.env.CONCURRENCY`) is that number
  (`coerceNumericString`, `src/client/tcp/numeric.ts`); any other string throws;
- an option the active mode never reads is not validated: `drainDelay` only matters
  without a long-poll (`pollTimeout > 0 ? 10 : drainDelay`), `lockDuration` only with
  `useLocks`, and `batchSize` not at all under a native `batch` (whose `size` is the
  pull size).

| Option              | Accepted                                                 | Why                                                                                                                         |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatInterval` | `0`, a negative value or NaN disables both heartbeats (2.9.10's `> 0` guard); otherwise finite, >= 1 | Drives two intervals; a positive value below 1 ms or Infinity ticked about every millisecond. The rule matches SandboxedWorker's, except that SandboxedWorker rejects NaN (2.9.10 armed it) |
| `pollTimeout`       | >= 0, `Infinity` allowed; above 30000 clamped to 30000; a negative value or NaN is 0 | Sent as the PULL `timeout`; 2.9.10 long-polled only when `> 0`, and a negative or NaN `timeout` made the broker refuse every PULL |
| `drainDelay`        | finite, >= 1 (checked only when `pollTimeout` is 0)      | Re-arms the empty-queue pull loop; `0` re-polls continuously (~870 pulls/s, as NaN did); 1 ms is the timer resolution        |
| `lockDuration`      | finite, 1 to `Number.MAX_SAFE_INTEGER` (checked only with `useLocks`) | The lease TTL (`lockTtl`): the lease expires at `now + lockDuration`, so `0` or less is already expired (a job ran twice) and NaN never expires. The upper bound is the broker's `lockTtl` bound, so a Worker never sends a lease the broker refuses |
| `concurrency`       | a number > 0 (a fraction rounds up: 2.5 runs 3 jobs) or `Infinity` (no limit) | Gates starts with `active >= concurrency` and sizes the TCP pool (`min(concurrency, 8)`): `0`, a negative value and NaN never started a job |
| `batchSize`         | a number > 0 (a fraction rounds up), `Infinity` allowed; above 1000 clamped to 1000 | `0` or a negative value never pulled; NaN went out as the PULLB `count`, which the broker refuses; 2.5 pulled 3 jobs (`jobs.length < count`) |

No duration has an upper bound: an interval or delay above 2^31 - 1 ms is honoured
exactly by the timer helpers, and `lockDuration` arms no client timer at all. The
`concurrency` setter keeps its documented clamp (a value below 1, or `null`, becomes 1),
rounds a fraction up, keeps `Infinity` and coerces a numeric string, as on 2.9.10; NaN or a
non-number throws `Worker.concurrency must be a number > 0 or Infinity (got NaN)` and
leaves the value unchanged.
`limiter.duration` (finite, > 0) and `batch.timeout` (a non-negative safe integer)
keep their existing checks.

`batch: { size, minSize, timeout, groupAffinity }` enables native batch
processing. One processor invocation receives a leading job whose `getBatch()`
returns every leased member; `setAsFailed(error)` selectively fails one member.
Each member retains its own lease, ACK/failure transition, events, and cleanup.
`groupAffinity` never mixes group IDs in one batch. `minSize` waits indefinitely
when `timeout` is omitted and permits a partial batch after the timeout. Without
group affinity, grouped batches ignore `minSize`, matching BullMQ Pro. A Worker
limiter reserves one start per batch member only after the batch is ready;
waiting for `minSize` consumes no limiter capacity. Synchronous processor throws
are shared across the batch without invoking the processor again. A global
Worker limiter rejects `minSize > limiter.max`; `size` may remain larger and
ready work is processed in capacity-bounded chunks. The `groupKey` limiter form
is per-group concurrency and is not subject to this rolling-window constraint.

Processors receive `{ signal }` as their second argument. `cancelJob`,
`cancelAllJobs`, and per-job `timeout` (only a timeout the broker enforces, see
Processing & outcome) abort that signal and Observable
subscriptions are unsubscribed. A native batch composes every member signal:
cancelling or timing out any member aborts the shared processor invocation and
all members observe its shared outcome. Promise processors remain cooperative:
aborting does not fabricate cancellation of a Promise that ignores its signal. A
structural Observable is accepted without an RxJS dependency; its final
emission becomes the job result, and its teardown runs exactly once after
completion, failure, or abort, including synchronous settlement. `QueuePro`,
`WorkerPro`, `QueueEventsPro`, and `JobPro` are compatibility aliases over the
same native implementations.

`rateLimitGroup(job, duration)` requires a grouped active job, installs a
broker-authoritative manual deadline for that group, then returns the current
delivery to waiting with its lease token. It is effective without a configured
`group.limit`; SQLite keeps the live manual deadline in process while
PostgreSQL stores it transactionally for all brokers.
The deadline is committed before the active delivery is returned to waiting;
if that lease transition rejects, the Promise rejects but the group cooldown
remains active.

In embedded mode the constructor claims the same process-wide manager used by
Queue and QueueEvents. A supplied `dataPath` must identify its active database;
a mismatch throws synchronously before polling or worker registration begins.

`run()` (`worker/runtime/control.ts`) sets `running`, defers a `ready` emit via
`queueMicrotask` (so immediately attached listeners still fire), subscribes to
queue-scoped stalled events, registers the worker, and starts job-lease and
worker-registration heartbeat timers. Both are `safeInterval`s with period
`heartbeatInterval` (the job-lease one only without `skipLockRenewal`, neither
when it is `0`): the embedded lease timer calls `manager.jobHeartbeat` per pulled
job, the TCP one sends `JobHeartbeat`/`JobHeartbeatB` (`workerHeartbeat.ts`), and
the registration one sends `Heartbeat`. A period above 2^31 - 1 ms is re-armed per
period instead of ticking every millisecond. In TCP mode it waits for the dedicated
event subscription attempt before the first poll; a failed event connection
does not suppress processing, and normal reconnect logic later re-subscribes.
`pause()` stops new polling but intentionally preserves both heartbeat timers:
active and buffered deliveries must retain their leases, and the broker must
retain the worker registration. `resume()` reuses those timers instead of
creating duplicate intervals, so repeated pause/resume cycles remain
idempotent and `close()` can release every owned runtime handle. Starting
`close()` is a terminal lifecycle transition: `run()` and `resume()` become
no-ops as soon as shutdown owns its promise, so a stale timer or callback
cannot clear the closing/force state and restart polling during teardown.

### Pull loop

`poll()` (`worker/runtime/polling.ts`) first retires its current wake-up handle,
then returns if not running/closing. If `activeJobs >= concurrency` it
reschedules in 10ms; if the rate limiter blocks, it waits for the next slot;
otherwise it starts `tryProcess()` immediately. Worker startup, timer wake-ups,
and resume therefore keep their existing scheduling behavior. Only job
completion callbacks use the `processingScheduled` gate and a shared follow-up
dispatch, so a released wave of 64 leases requests the next available capacity
with one `PULLB` instead of racing 64 one-job `PULL` transactions. Every concurrency, group,
empty-pull, rate-limit and error-backoff path uses one earliest-deadline scheduler, so
concurrent completion and pull continuations leave at most one live poll timer
without allowing a later request to postpone an earlier wake-up. The timer
callback verifies that it still owns the current handle before polling;
`pause()` and `close()` use the same idempotent cleanup. This preserves the
existing delays and pull fan-out without allowing completed jobs to create
self-perpetuating orphan timer chains (issue #113). `tryProcess()` repeats the
limiter check before any batch pull, so its pipelined fan-out cannot bypass
admission.

The one wake-up is a `safeTimeout`. Its delay is 10 ms (a full concurrency gate, a
blocked group buffer, or an empty long-poll), the validated `drainDelay` after an
empty short poll, the pull-error backoff (100 ms doubling to 30 s), or the limiter
wait: `max(10, time until the next slot)`, the longer of the rolling-window wait
(up to `limiter.duration`) and a `rateLimit(ms)` override. Those last two are
finite but unbounded, so a window or override above 2^31 - 1 ms parks the loop
until it ends instead of re-polling every millisecond. The native-batch
`minSize` refill (`fillPendingBatch`, at most 10 ms) uses `safeTimeout` too.

`tryProcess()` (`worker/runtime/polling.ts`) picks an eligible buffered job
(`runtime/buffer.ts`) or pulls a batch. After the async pull it **re-checks**
`running/_closing` and the concurrency gate before `startJob`; a full gate puts
the item back at the buffer front (issue #96). Empty polls emit `drained` at
most once per second.

`doPullBatch()` (`worker/runtime/polling.ts`) computes the **leased** count,
subtracts `pendingPull`, caps the batch at 1,000 and at the unconsumed worker
rate budget, and reserves the requested slots across the asynchronous pull
(issue #98). A worker limited to two starts therefore leases at most two jobs;
the rest remain broker-visible as waiting. `runtime/buffer.ts` registers the
leases and immediately renews freshly pulled locks when a multi-connection
pool could otherwise create a re-dispatch window.

Every successful pull is assigned a monotonically increasing local delivery
generation in `runtime/state.ts`. `startJob()` (`runtime/execution.ts`) rejects
only an exact duplicate generation; a stall-recovered delivery of the same job
id can start while its stale handler is still running when concurrency permits.
It then atomically acquires the worker rate token at the actual dispatch
boundary. A denied item is returned to the local buffer. Cleanup is
generation-conditional: an old `.finally` decrements only its own active/group
counts and cannot delete the current token, heartbeat membership, cancellation
state, or pulled-job tracking. Automatic and manual processing share this
contract.

`WorkerRateLimiter` uses a rolling start-time window. `rateLimit(ms)` is a
separate temporary override: it blocks admission even when no normal limiter
is configured or when `groupKey` selects group-concurrency mode. The effective
wait is the longer of the rolling-window wait and the override. Manual
`processJobManually()` uses the same admission rule and waits without invoking
the processor until both its rate token and group slot are available.

`getNextJob()` returns a `ManualJob<T>` copy rather than the broker's mutable
domain object. Its first-class `name` is separate from the typed user `data`,
and `token` contains the broker lease when locks are enabled. Passing that job
to `processJobManually()` without a token reuses its tracked lease; an explicit
token must match. The worker processes the canonical tracked delivery, and a
job object from an older redelivery generation cannot replace or publish an
outcome through the current generation.

### Processing & outcome (`processor.ts`, `processorOutcome.ts`)

`processJob` builds the public `Job` with all handlers (`worker/handlers/`),
emits `active`, then awaits `processor(job)`. A confirmed `moveToCompleted()`,
`moveToFailed()`, `retry()`, `changeDelay()`, `moveToWait()`,
`moveToDelayed()`, or `moveToWaitingChildren()` consumes the current processing
generation, so the Worker skips its automatic ACK and catch-path FAIL. The five
asynchronous nonterminal handlers mark ownership only after the broker confirms
the transition; a rejected token therefore still enters normal failure
handling. Otherwise the Worker acks — embedded
`manager.ack(id, result, token)` or `ackBatcher.queue(...)` — then emits
`completed`. Failure/manual/delayed outcome logic is isolated in
`processorOutcome.ts`. `shouldAbandonOutcome` checks the local job timeout,
forced shutdown and delivery currency: once a newer generation is registered,
the stale processor sends no ACK, FAIL, delayed transition, or terminal event.
A broker-side token/generation check remains the final race guard.
Completion handler factories take one explicit options record so transport,
lease token, retention policy, and manual-transition callbacks stay coupled.

**Per-job timeout.** The broker is the timeout authority: at the job's deadline
its `JobTimeoutScheduler` fails the job with `FailureReason.Timeout`, a retry or a
terminal failure ([Background Tasks](./background-tasks.md)). When the Worker's own
timer fires it aborts the processor signal and then abandons that delivery's
outcome (no ACK, FAIL or event); the broker's transition settles the job, and a
late outcome would be ignored by it anyway. That is only safe if the two agree on
which deadlines exist, so both take the rule from one domain module,
`src/domain/job/timeoutRule.ts`: the scheduler registers `processingDeadline(job)`,
and automatic (`runtime/execution.ts`) and manual (`runtime/manual.ts`) processing
arm the timer from `processingTimeoutDelay(job)`:

- an absent, `0` or `NaN` timeout is no timeout, so nothing is armed;
- the deadline is `Math.ceil(startedAt + timeout)`, so a fraction is rounded up and a
  negative timeout is already due;
- a deadline that is not a safe integer (`±Infinity`, an overflow) is
  `NEVER_DEADLINE` to the broker, so nothing is armed either.

The timer is a `safeTimeout` for the broker's own distance from `startedAt`, armed
when the Worker starts the job (never before `startedAt`), so the abort never
precedes the broker's deadline and a timeout above 2^31 - 1 ms is honoured.
Previously the Worker armed `setTimeout(abort, job.timeout)` for any non-null
timeout: `0` (legal in every producer), `NaN` or an infinity aborted the processor after
about 1 ms and abandoned an outcome the broker never settled, and a timeout above
2^31 - 1 ms overflowed to 1 ms; the job stayed `active` with no event until lease
or stall recovery. Producers (TCP `PUSH`, embedded `Queue.add`) now accept only
0..24 h, but the broker stores whatever it is given (a direct `QueueManager.push`,
an older release, another client), so the Worker handles every stored value.
`test/worker-job-timeout-rule.test.ts` pins the rule, checks the real scheduler
registers exactly `processingDeadline(job)`, and checks that neither side keeps its
own copy; `test/repro-worker-job-timeout.test.ts` covers both modes, pushing the values
no producer accepts straight into the broker.

`Job.discard()` retains its synchronous public signature, but its Worker
handler registers one pending disposition before returning. `processJob`
awaits that non-rejecting settlement, including during graceful close, and
never races it with ACK/FAIL. Duplicate calls share the first command. An
authoritative already-absent job is silent; a real transport/engine rejection
emits one `error` with `context: 'discard'` and leaves lease/stall recovery in
charge. The Worker sends its captured token, so a stale processor cannot
discard a newer delivery generation.

Failure path (`handleJobFailure`, `processorOutcome.ts`): `DelayedError` →
`handleDelayedError` re-delays the job by `calculateDelayedErrorDelay(job)`
(`src/domain/job/state.ts`) without counting a failure and forwards the current
lease token in both transports. The wait is `min(base, cap)` with no attempt
growth and no jitter. `base` is `backoffConfig ? backoffConfig.delay : backoff`
when that is a positive number, else `1000` (covers `0`, negative and `NaN`
bases from embedded admission). `cap` is `backoffConfig.maxDelay` when that is a
positive finite number, else `DEFAULT_MAX_BACKOFF`. A `maxDelay` of `0` (which
makes failed retries immediate) does not apply here: DelayedError never counts
an attempt, so a zero wait would let a processor that keeps throwing it re-pull
the job in a tight loop. The wait is therefore always positive and finite, and
a `maxDelay: 0` job waits its base delay capped at 1 hour. Embedded calls
`manager.moveToDelayed`; TCP sends `MoveToDelayed` with that `delay`, using the
`backoffConfig` parsed from the pulled job. `SandboxedWorker` does not recognize
`DelayedError`: the error crosses the worker-thread boundary as a message string
and the job is failed like any other error;
`UnrecoverableError` → forces `maxAttempts=1, attempts=0` so retries are
skipped; stack lines are computed _before_ the send (capped at 50 on the wire,
authoritative cap server-side — bug #74), then `FAIL` is sent (embedded
`manager.fail`, TCP `FAIL` with `stack`/`token`/`unrecoverable`). `failedReason`
and `stacktrace` are populated on the event object, then `failed` is emitted
only when the broker confirms that this processing generation applied the
transition. If an exact timeout/retired-cron generation already won, the
structured `applied:false` response is authoritative: automatic failure,
manual `moveToFailed`, ACK, and ACKB emit neither `failed`/`completed` nor an
`error`, and do not increment Worker counters or release a newer lease.

### Sandboxed flow (`sandboxed/runtime/`)

`lifecycle.ts` writes the wrapper, starts the process pool, owns heartbeat and
shutdown. `pool.ts` spawns/recycles Bun Workers and runs the pull loop.
`dispatch.ts` owns the per-job timeout and routes result/error/progress/log IPC
messages, rejecting messages that do not match the worker's current job.
A thread's progress goes through `progressUpdate` (`client/queue/commandArgs.ts`)
in the queue ops of both modes, as for every job object. An object becomes
progress 0 with its JSON as the message; a non-number is refused before anything is
sent and emitted as `error` with `context: 'progress'` and `jobId`.
It claims the local generation before awaiting ACK/FAIL, cancels its local
timer, and keeps the thread busy until the broker settles. A late result,
processor error, explicit `job.fail`, or local sandbox timeout is silent when
the broker reports that an earlier timeout already finalized that generation.
`recovery.ts` fails crashed work, bounds respawns by `maxRestarts`, renews
leases, and creates the public event job. Idle recycling keeps at least one
process alive; `autoStart` can watch the queue after an idle stop.

`options.ts` resolves every duration option in the constructor, before the
shared TCP pool or embedded manager is acquired (see Configuration). Every
timer goes through the shared helpers ([Shared Timers & Durations](./shared-timers.md)):
the per-job timeout is a `safeTimeout` kept in `WorkerProcess.timeoutId`, and the
heartbeat and the idle watch (`autoStartPollMs`) are `safeInterval`s. While every
thread is busy, the pull loop waits `pollInterval` through a `safeTimeout` that
`stop()` ends at once (`wakePullLoop()`), so a long `pollInterval` never delays
shutdown. A duration above 2^31 - 1 ms is therefore honoured, never early, both in
Bun and in the portable `bunqueue-client` build, where `Bun.sleep` becomes a native
`setTimeout`.

Lifecycle (`lifecycle.ts`):

- **Shared teardown.** Every stop shares one teardown: stop pulling, wait for busy
  threads (skipped by `stop(true)`, which also cuts short a graceful teardown in
  progress), clear the heartbeat and per-job timers, terminate the threads and
  delete the wrapper. Concurrent stops await the same run, and `start()` waits for
  a teardown in progress before it begins.
- **A user stop wins.** A lifecycle epoch moves on every `start()` and `stop()`.
  An idle stop (`idleStop()`, or `stopAndWatch()` with `autoStart`), an idle-watch
  check and a `start()` capture the epoch and abandon once it moves. A `stop()`
  during an idle drain therefore leaves no watch armed. A Count answered after
  `stop()` restarts nothing, and a restart still starting threads returns early,
  leaving `stop()` to tear down what it created.
- **One pool reference.** In TCP mode the worker holds at most one reference on
  the shared pool (`holdsPool`). The constructor takes it, and a terminal stop
  (`stop()` or `idleStop()`) releases it exactly once. `stopAndWatch()` keeps it,
  because the watch polls through it, and `start()` re-acquires it with
  `getSharedPool(connection)` and rebuilds `tcp`/`ops`. A repeated `stop()`
  therefore never closes a pool that other clients share, and `start()` or an
  `autoStart` restart never uses a closed pool.
- **One Count in flight.** The idle watch is a chain of one-shot `safeTimeout`
  checks. Each check is armed only after the previous one finished, after
  `autoStartPollMs` (a failed Count waits one period), so a slow broker never
  accumulates requests.
- **Failed start.** When `startPool()` throws (TCP connect, wrapper, a thread that
  fails to load), `start()` tears down what it created with a forced teardown and
  rejects, leaving `running` false.
  - If the start began while idle-watching (the watch's restart, or a user
    `start()` then), the worker keeps its pool reference and re-arms the watch
    after `autoStartPollMs × 2^restartFailures`, capped at
    `max(autoStartPollMs, 30 s)`.
  - Otherwise it releases the pool reference, as a stop does.
  - The watch's own restart failure is emitted as `error` with
    `context: 'restart'`, `queue` and `consecutiveErrors`; a user `start()` gets the
    rejection instead.
  - A successful start resets `restartFailures`.
- **`closed` once per cycle.** A cycle begins at construction and at every
  `start()`, and `closed` fires once in it, from the first stop of that cycle.

Pull loop (`pool.ts`):

- **Only loaded threads get jobs.** `pullOnce()` pulls only for a thread that is
  running, idle and loaded (`isIdle`: not `busy`, not `terminated`, not `loading`).
  With none it respawns a recycled slot (that thread is pulled for on a later pass,
  once loaded), stops when every slot is retired, or waits `pollInterval`. A
  restarted or new thread therefore gets no job while its processor still loads.
- **Every pass is guarded.** `pullOnce()` pulls and dispatches. A transient refusal
  (`quietPullOrThrow`, `worker/pullFailureLog.ts`: rate limit, lock timeout, `Internal
  server error`) is read as an empty pull, as 2.9.10 read it (spare threads recycled,
  `idleTimeout` counted), and not reported; the next pass follows after `pollInterval`
  (default 10 ms), where 2.9.10 re-pulled at once, a request flood against a
  rate-limiting broker. When the pass throws (a rejected pull, a permanent refusal, a
  respawn that fails), `recoverPullLoop()` keeps the loop running, as Worker's
  `handlePullError` does: it arms a stop-wakeable wait of 100 ms doubling to 30 s
  (`WORKER_CONSTANTS`), then reports.
- **Reset and shutdown.** An answered pull, even an empty one, resets the streak, and
  a `stop()` during the wait ends the loop at once.
- **The report** is `error` with `queue`, `consecutiveErrors` and `context` 'pull' or
  'spawn', emitted only to an attached listener. A pull failure goes through
  `PullFailureLog.report` (`worker/pullFailureLog.ts`), as Worker's does: a transient
  refusal (`isQuietPullFailure`: rate limit, lock timeout, `Internal server error`) is
  not reported at all, as on 2.9.10, where it read as an empty queue; a listener that
  throws is logged at most once a minute, never rethrown; without a listener, a
  permanent failure (e.g. a refusal for a wrong token) is one console line naming the
  SandboxedWorker, the queue and the reason, at most once a minute, and a transient
  thrown error stays quiet. A spawn failure (already emitted by `handleCrash` as
  `crash`) reaches only an attached listener (one that throws is logged). No unheard
  `error` is emitted, so a refusal never becomes an unhandled rejection that ends the
  process.
- **Undispatched jobs.** A job pulled for a thread whose respawn then fails is
  failed with `Dispatch failed: <reason>`, so it does not keep its lease.
- **Refused pulls.** The TCP `pull` op (`queueOps.ts`) throws Worker's
  `PullRefusedError` on a reply with `ok !== true` instead of reading it as an
  empty queue.

Crashed threads (`thread.ts`, `recovery.ts`):

- **Readiness.** A new thread record (`spawnWorker`) starts `loading`. The wrapper
  installs its message handler first, then awaits the processor import, then posts
  `ready`; `watchThread()` clears `loading` on that `ready` whenever it comes. Bun
  drops a message that reaches a thread with no handler, so a job posted while the
  processor loaded used to be lost: after a crash the restart (not awaited) left an
  idle record at once, and the next job stayed `active` for good under `timeout: 0`
  (or timed out and burned a restart). `start()` and a respawn wait for `ready` at
  most `READY_TIMEOUT_MS` (5 s); a thread still loading after that stays `loading`
  and gets its first job once ready (`test/repro-sandboxed-restart-ready.test.ts`).
  The wrapper also lets a job that does arrive early wait for the import.
- **Detecting a death.** `watchThread()` wires a new thread's events. In Bun an
  uncaught error or unhandled rejection raises `error` then `close`, and a
  `process.exit()` raises only `close`; bunqueue-client's worker_threads adapter
  reports both through `onerror` and has no `addEventListener`. A death the pool
  did not cause (a slot not already `terminated`; recycling and job timeouts mark
  it first) calls `handleCrash(slot, reason)`. A death before `ready` also rejects
  the spawn, so a processor that fails to load fails `start()`. A restarted thread
  whose processor fails to load is a crash like any other: it counts against
  `maxRestarts` and is handed no job, so the pending job stays waiting.
- **`handleCrash` runs once per thread** (`crashed`):
  - it terminates the thread;
  - it fails the running job with `Worker crashed: <reason>` through the normal
    `fail()` path (broker retries per `attempts`; `failed` is emitted when applied),
    so the job never keeps its lease;
  - it emits `crash` (with `workerIndex`; for a timeout only when the broker
    applied it) and increments `restarts`.
- **Restart or retire.** With `autoRestart` and `restarts < maxRestarts` the slot
  is respawned (not awaited; the new record is `loading`). Otherwise it is `retired`: the pull loop never gives it a job and
  never respawns it (`recyclableSlot()` skips retired and still-settling slots),
  and the loop is woken.
- **Exhaustion.** When every slot is retired, the pull loop calls `stopExhausted()`
  instead of pulling. That emits `error` with `context: 'exhausted'` (and logs
  it), then runs the terminal `idleStop()`: no watch, even with `autoStart`,
  because a restart would crash again. A later `start()` spawns fresh slots with
  a fresh budget.
- **Degraded capacity.** While some slots still work, the worker keeps running on
  them.
- **Jobs pulled for a dying slot.** A job pulled for a slot that died during the
  pull goes to another loaded idle thread, or to one that finishes loading (a
  restarted slot, or a respawned recyclable one) within `READY_TIMEOUT_MS`; with
  neither, it is failed as `Dispatch failed: no live sandbox thread to run it`.
- **Stop during a restart.** A thread still loading is in `workers`, so the
  teardown terminates it; its spawn rejection is not logged once the pool stopped.
- **Idle recycling** skips a thread still loading and does not count it as a spare.
- **Graceful stop** waits for every `busy` slot, including a dead thread's FAIL
  still settling.

## Concurrency & Locking

- **Concurrency cap** is enforced as a leased cap (`pulledJobIds.size`), not
  just `activeJobs`, plus the `pendingPull` reservation in
  `worker/runtime/polling.ts`. The gate is re-checked immediately before
  `startJob` in `runtime/execution.ts`.
- **Lock-based ownership** (`useLocks`, default true): each pulled job gets a
  `token`; heartbeats renew the lock for **all** `pulledJobIds` (active and
  buffered) so buffered jobs don't expire (`workerHeartbeat.ts:24`). Lock TTL =
  `lockDuration` (default 30000), propagated to the server via `lockTtl` on
  pull (`workerPull.ts:79`). Manual pulls expose the same broker token on the
  returned `ManualJob`; manual processing reuses the tracked value when its
  token argument is omitted. ACK, FAIL, batched ACK, shutdown requeue, and all
  manual active-state moves forward that token. The broker requires the exact
  token whenever a lock exists in both transports; unlocked jobs retain the
  administrative transition path. See
  [Concurrency & Locking](./concurrency-and-locking.md).
- **PostgreSQL disconnect fencing:** the multi-broker manager snapshots all
  tracked `(jobId, token)` pairs before the first awaited or deferred release.
  Store fencing revalidates that immutable token, and local cleanup removes it
  only if the active-token map still contains the same value. Reusing a custom
  ID while old disconnect work is queued cannot release or forget the newer
  lease. This is PostgreSQL adapter behavior; the existing SQLite lock path is
  unchanged.
- **Stall race (#33)**: stall detection may re-dispatch a job while the old
  handler still runs. The new pull receives a fresh broker token and local
  delivery generation. Only the current generation is heartbeated and allowed
  to publish an automatic outcome; stale cleanup cannot erase its state.
- **Re-dispatch window (multi-connection)**: with `poolSize>1`, PULL and
  heartbeats may travel on different sockets; `worker/runtime/buffer.ts` sends
  an immediate heartbeat after a lock-based batch pull.
- **Group concurrency**: `GroupConcurrencyLimiter` caps `limiter.max` active
  jobs per group; `runtime/buffer.ts` scans for a runnable group and
  `runtime/polling.ts` permits bounded pull-ahead when the buffer is blocked.
  Automatic and manual dispatch increment the group exactly once and release
  it in their terminal cleanup; `duration` remains unused in group mode.
  Group-value extraction never throws (see
  [Rate Limiting & Concurrency](./rate-limiting-and-concurrency.md)), so a
  producer-supplied value such as `{ toString: 'x' }` cannot break the pull
  loop, the ACK frontier, or the `concurrency` setter.

## Edge Cases & Failure Modes

- **Pull errors**: `handlePullError` in `worker/runtime/polling.ts` arms the retry
  first (backoff 100 ms doubling to 30 s), then reports the error, decorated with
  `queue`, `consecutiveErrors` and `context: 'pull'`, through `reportPullFailure`
  (`runtime/manual.ts`, `PullFailureLog.report` in `worker/pullFailureLog.ts`). A
  transient refusal (`isQuietPullFailure`) is not reported at all, as on 2.9.10, where
  a refused pull looked like an empty queue, so an app that alerts on every `error`
  does not start firing on rate limits. Anything else is emitted as `error` while the
  Worker has an `error` listener; a listener that throws is caught and its failure
  logged (at most once a minute), never rethrown, so it cannot become one unhandled
  rejection per failed pull. Without a listener, a permanent failure is written to the
  console: one line naming the Worker, the queue and the reason, on the first failure
  and then at most once a minute (`PULL_FAILURE_LOG_INTERVAL_MS`); a transient thrown
  error stays quiet. No unheard `error` is ever emitted: EventEmitter throws it, and
  from the pull loop that became an unhandled rejection that could end the whole
  process (2.9.10 kept running). Before, a throwing emit skipped the retry, so the
  loop died. A pull the broker
  answers, even an empty one, resets the counter (both in `tryProcess()` and in the
  native-batch refill). Picking an already-buffered job no longer resets it, so a
  failing `minSize` refill keeps escalating. A failed refill retries through that
  backoff instead of the 10 ms refill timer, which used to retry about 100 times
  per second.
- **Refused pulls** (`workerPull.ts`): a PULL/PULLB reply with `ok !== true` is a
  `PullRefusedError` (`name`, `command`, `reason`, `transient`; message
  `PULL refused by the broker: <reason>`). It is a pull error, never an empty queue
  (an empty queue is `ok: true` with no job), so it emits no `drained`. A permanent
  one goes through `handlePullError`. A transient one is read by `doPullBatch` as no
  job (`QUIET_REFUSAL`, `runtime/polling.ts`), as 2.9.10 read every refusal: the loop
  re-polls on its empty-pull cadence (`pollTimeout > 0 ? 10 : drainDelay`, 50 ms by
  default) and a native-batch refill on its 10 ms refill timer, with no failure streak
  (an answered pull resets it), so sustained broker rate limiting or lock contention
  never delays job pickup by a growing backoff. Before, every refusal read as an empty
  queue. A Worker
  the broker refused for good (an invalid queue name, a rejected option, a missing
  auth token, a newer client option an older broker rejects) sat silently idle,
  emitted false `drained` events and re-polled every `drainDelay`, or every 10 ms
  with long-polling.
  - A refusal is transient (`isTransientRefusal`) when it passes with time: the
    replies the job wait retries (`isTransientReply`: the protocol `Rate limit
    exceeded`), a shard lock wait that outlasted `LOCK_TIMEOUT_MS` under broker
    contention (`Lock acquisition timed out`, `Read lock acquisition timed out`,
    `Write lock acquisition timed out`; `LOCK_TIMEOUT_MESSAGES` from
    `shared/lockError.ts`, the same constants the locks throw, which the broker
    returns unredacted), or a storage error the broker redacts to `Internal server
    error` (a busy database, a PostgreSQL broker shutting down). Before refusals
    were classified, a lock timeout read as an empty poll; it must never crash a
    Worker that has no `error` listener (`test/repro-worker-pull-lock-timeout.test.ts`).
  - Transient refusals are re-polled on the empty-pull cadence and never reported, by
    Worker and SandboxedWorker alike, even to an attached listener (2.9.10 emitted
    nothing for them). The `LockTimeoutError` an embedded pull throws itself under
    shard contention (no refusal wraps it in-process) and transient thrown errors
    (`Command timeout`, `Connection lost`, `Not connected`; `isTransientPullError`)
    are retried the same way and reported only to an attached `error` listener, as
    2.9.10 emitted them. A rate limit, broker lock contention (TCP or embedded) or a
    broker restart therefore never crashes a Worker that has no listener
    (`test/repro-worker-embedded-lock-timeout.test.ts`).
  - A permanent refusal, like any other pull error, is emitted as `error` to an
    attached listener; without one it is logged (at most once a minute) and never
    ends the process. The backoff continues either way, so the Worker resumes as soon
    as the cause is fixed (a token rotated in, a queue renamed).
  - `getNextJob()` resolves `undefined` on any refusal, as on 2.9.10, so a manual
    loop written for "no job" never breaks; a permanent refusal is also reported
    through `reportPullFailure` (an `error` event with `context: 'pull'`, or the
    console line). A timed-out command, a lost connection and an embedded
    `LockTimeoutError` still reject.
  - `test/repro-worker-pull-refusal.test.ts`,
    `test/repro-compat-client-pull-refusal.test.ts` and
    `test/repro-compat-client-pull-quiet.test.ts` cover these cases, including child
    processes with no listener (a Worker that recovers once the refusal stops, and a
    SandboxedWorker) and with a listener that throws.
- **ACK batching/backpressure** (`ackBatcher.ts`, `ackFrontier.ts`): flush triggers at the configured batch size, capped in TCP mode by an event-driven reachable-outcome frontier, or after `interval` (`DEFAULT_ACK_INTERVAL=50ms`). The frontier is the ACKs already pending plus started delivery generations that can still ACK plus scalar buffered deliveries that can start without first settling a pending ACK. Buffered eligibility observes runtime concurrency, rate capacity, and simulated per-group reservations; a sealed native batch contributes its exact started members rather than its configured maximum. A generation transfers synchronously from the unqueued set into the pending batch, while failure, an applied manual transition, pause, rate-limit changes, concurrency changes, and close re-evaluate a reduced frontier. ACKs assigned to an in-flight flush no longer contribute to later batches. Evaluating the dynamic ceiling never throws out of `queue()` or `notifyCapacityChanged()`: once an ACK is pushed into the pending batch it stays owned by the batcher, so if the ceiling callback throws, the batcher falls back to the static `batchSize` (the `interval` timer is still armed), reports the error through `onThresholdError` (the Worker emits `error` with `context: 'ack-threshold'` only when an `error` listener exists; a throwing observer is ignored), and never rejects the ACK promise — so a successful job is never turned into a FAIL, and the `concurrency`/`pause`/`rateLimit` setters and failure-path frontier retirements cannot throw from it. The buffer is bounded at `MAX_PENDING_ACKS=10000`; `queue()` blocks (awaits in-flight, then flushes) rather than dropping acks. `sendBatchWithRetry` retries transient failures up to `maxRetries=3` with exponential backoff (`100,200,400ms`). A valid structured `ignoredIndices` response settles only those exact pending positions as `false` without retry or error; malformed/unknown evidence is rejected. On true exhaustion it logs `(N acks lost)` and rejects each pending promise. `stop()` clears any still-queued acks _without settling their promises_ (callers are expected to `flush()` + `waitForInFlight()` first, as `Worker.close()` does); a batch already mid-retry when `stop()` lands is rejected with `AckBatcher stopped`.
- **Graceful close** (`worker/runtime/lifecycle.ts`): `close(false)` stops
  timers, moves buffered leased jobs back to waiting, waits only for active
  processors, flushes ACKs, unregisters, and closes the pool. `close(true)`
  breaks an in-progress graceful drain. Shutdown state is monotonic from the
  first call, so stale `run()`/`resume()` calls cannot pull a batch after close
  begins. It cannot cancel arbitrary user code,
  so a processor may still return later; that late outcome is abandoned before
  any broker command or event. The unfinished job remains recoverable through
  disconnect handling or server lock/stall expiry.
- **Ownership and waiting-children transitions:** processor and sandboxed `Job` objects route `removeDeduplicationKey` through the owner-aware manager/wire operation and route `moveToWaitingChildren` through the real broker transition in both modes. A stale deduplication owner returns `false`; moving a non-active job returns `false` or a broker error rather than silently changing unrelated state.
- **Job mutation handlers** (`processorHandlers.ts`) are state-aware: `retry`
  dispatches by job state (failed → `retryDlq`, active → `moveActiveToWait`,
  waiting/prioritized/delayed → no-op, else throw); `moveToDelayed` converts an
  absolute timestamp to a relative delay (`delayUntil`: a finite timestamp, or its plain decimal string; a past one
  means now, as on 2.9.10). `changeDelay`, `moveToDelayed` and `extendLock` validate their
  argument with the broker's validators before anything is sent (`handlers/mutations.ts`,
  also used by sandboxed jobs), and `extendLock` resolves `duration`, `0` for a
  missing lease, or throws any other broker rejection in both modes (TCP used to
  resolve `0` for every rejection, hiding a validation error; see
  [Job Options Validation](./job-options-validation.md)). `changeDelay` throws
  `Job not found or cannot change delay` in both modes (embedded used to say
  `Failed to change delay for job ...`); `promote` and `updateProgress` read the TCP reply
  and resolve without change for a job that is no longer delayed or active. Processor-owned `retry()`,
  `changeDelay()`, and synchronous `discard()` bind the delivery token captured
  by `processJob`. Embedded calls pass it directly to the manager and TCP calls
  include it in `MoveToWait`/`ChangeDelay`/`Discard`; rejected broker responses
  cannot become silent automatic completions.
- **Sandboxed dispatch failure** awaits the authoritative broker transition and
  resets the worker only after settlement (`sandboxed/runtime/dispatch.ts`).
  Ignored retired generations are silent. Crash/timeout recovery (see "Crashed
  threads" above) and guarded error emission live in
  `sandboxed/runtime/recovery.ts`; wrapper-path escaping lives in
  `sandboxed/wrapper.ts`.
- **`prefixKey` mismatch**: a Worker only consumes jobs whose producing Queue
  used the same prefix; `worker/runtime/state.ts` creates `queueKey`, and
  `runtime/control.ts` scopes stalled events to it.
- **`skipStalledCheck` scope**: in either runtime it disables only this Worker's
  `stalled` listener subscription. It does not disable broker-side recovery,
  stall counters, retries, or DLQ transitions.
- **Duration arguments** (`runtime/control.ts`, `runtime/manual.ts`) are validated
  with `assertDuration` on entry, like the options:
  - `delay(milliseconds?, abortController?)` (BullMQ signature) takes a finite
    number (a numeric string is that number). Omitted, `null`, `0` or a negative value
    resolves at once (as on 2.9.10 and in BullMQ); a longer delay is a `safeTimeout`, so 34 days stays pending
    instead of resolving after ~1 ms. Aborting, or passing an already-aborted
    controller, rejects with `Delay aborted`, and the abort listener is removed when
    the delay completes. NaN, an infinity (both slept ~1 ms on 2.9.10) or a
    non-number rejects with `Worker.delay: milliseconds must be ...`.
  - `rateLimit(expireTimeMs)`: a value that is not a positive finite number (`0`, a
    negative value, NaN, an infinity, `null`) stays a no-op, as on 2.9.10 (BullMQ v5,
    `WorkerRateLimiter.rateLimit`); a numeric string is that number, and any other
    non-number throws (`Worker.rateLimit: expireTimeMs must be ...`).
  - `extendJobLocks(ids, tokens, duration)` takes a finite `duration` >= 1, like
    `lockDuration`: the broker renews the lease to `now + duration`, so NaN would
    never expire and `0` or less would expire it. As on 2.9.10, a closed Worker or an
    empty `ids` returns 0 before the check, an omitted or `null` duration renews each
    lease with its own TTL (`renewLock`: `newTtl ?? lock.ttl`), and a numeric string is
    that number.
- **Timers.** Every Worker timer whose delay is not a constant goes through
  `safeTimeout`/`safeInterval`: both heartbeats, the poll wake-up, the per-job
  timeout, `delay()`, the native-batch refill and the ACK-batch flush timer
  (`ackBatcher.ts`). `test/repro-worker-heartbeat-interval.test.ts`,
  `test/repro-worker-poll-loop.test.ts`, `test/repro-worker-delay.test.ts` and
  `test/repro-worker-duration-options.test.ts` cover them.

## Configuration

- **`WorkerOptions`** (see Data Models) — primary knobs. Defaults: `concurrency=1`, `heartbeatInterval=10000` (`0` disables), `batchSize=10` (max `1000`), `pollTimeout=0` (max `30000`), `useLocks=true`, `lockDuration=30000`, `drainDelay=50`, `maxStalledCount=1`, `autorun=true`.
  The durations are validated in the constructor (see Construction & startup):
  `heartbeatInterval` `0` (disabled; a negative value or NaN also disables) or finite
  >= 1, `pollTimeout` >= 0 or `Infinity` (clamped to 30000; a negative value or NaN is
  0), `drainDelay` finite >= 1 with no upper bound (only without a long-poll), and
  `lockDuration` finite from 1 to `Number.MAX_SAFE_INTEGER` (the broker's `lockTtl`
  bound; only with `useLocks`). So are the counts: `concurrency` a number > 0 (rounded
  up) or `Infinity`, `batchSize` a number > 0 (rounded up) or `Infinity` (clamped to
  1000; not read under a native `batch`). A numeric string is that number.
- **`FORCE_EMBEDDED` / `WORKER_CONSTANTS`** (`worker/constants.ts`): the env
  override plus backoff, poll-timeout, and ACK-interval constants.
- **`SandboxedWorkerOptions`** defaults: `concurrency=1`, `maxMemory=256` (≤64 → Bun `smol` mode), `timeout=30000` (`0` disables), `autoRestart=true`, `maxRestarts=10`, `pollInterval=10`, `heartbeatInterval=10000` (TCP) / `5000` (embedded), `idleTimeout=0` (disabled), `idleRecycleMs=30000`, `autoStart=false`, `autoStartPollMs=5000`.
  `sandboxed/runtime/options.ts` validates the durations with `assertDuration`, and
  `concurrency` as a finite number of threads, rounded up and at least 1, as 2.9.10's
  spawn loop read it (`0` starts 1 thread, `2.5` starts 3); Infinity (endless
  spawning) and NaN throw, e.g. `SandboxedWorker: concurrency must be a finite number
  of threads (got Infinity)`. `null` or `undefined` selects the default, and a numeric
  string is that number.
  - `timeout`, `idleTimeout` and `idleRecycleMs` take a finite number > 0; `0`,
    `Infinity`, a negative value and NaN disable the option (2.9.10 read each only
    when `> 0`) and are stored as `0`.
  - `heartbeatInterval` disables heartbeats at any value <= 0 and otherwise
    needs a finite number >= 1 (NaN throws: 2.9.10 armed a ~1 ms interval).
  - `pollInterval` and `autoStartPollMs` need a finite number >= 1.

  Anything else throws a `TypeError` (a non-number) or a
  `RangeError` naming the option, for example
  `SandboxedWorker: pollInterval must be a finite number of milliseconds >= 1 (got NaN)`.
  The 1 ms floor exists because a sub-millisecond period is below timer resolution:
  `Bun.sleep` resolves it at once and a native interval ticks every ~1 ms. There is
  no upper bound.
- TCP connection options are resolved by `createTcpPool` in
  `worker/runtime/options.ts`. Server env (`WORKER_TIMEOUT_MS`,
  `LOCK_TIMEOUT_MS`) affects server-side stall/lock handling, not the client.

## Related Docs

- [Client SDK: Queue](./client-queue-sdk.md) — the producer counterpart.
- [Client Transport (TCP pool, reconnect, batching)](./client-transport.md)
- [Job Lifecycle (push / pull / ack / fail)](./job-lifecycle.md)
- [Concurrency & Locking](./concurrency-and-locking.md)
- [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md)
- [Core Queue Engine (QueueManager & Shards)](./core-queue-engine.md)
- [Dead Letter Queue (DLQ)](./dead-letter-queue.md)
- [FlowProducer & Job Dependencies](./flow-producer.md)
- [Simple Mode (Bunqueue all-in-one)](./simple-mode.md)
- [TCP Server Command Handlers](./tcp-server-handlers.md)
- [architecture](../architecture.md) · [data-model](../data-model.md)
