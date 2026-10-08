# Client SDK: Queue

> **Category:** Client SDK · **Source:** `src/client/queue/queue.ts`, `src/client/queue/runtime/`, `src/client/queue/types/`, `src/client/queue/operations/`, `src/client/queue/job-proxy/`, `src/client/queue/dlq.ts`, `src/client/queue/backgroundCommand.ts`, `src/client/queue/addBatcher.ts`, `src/client/events.ts`, `src/client/queue-events/`, `src/client/types/events.ts`, `src/client/jobConversion.ts`, `src/client/jobWait.ts`, `src/client/job-wait/`, `src/client/manager.ts`, `src/client/queueGroup.ts`

## Purpose

`Queue<T>` is the producer-side, BullMQ-style SDK surface for adding and managing jobs. Its 27-line public façade inherits focused runtime capabilities for state, queries, control, configuration, scheduling, compatibility and connection lifecycle. Those layers transparently drive **embedded mode** or **TCP mode**, while public and internal contracts live separately under `queue/types/`.

TCP DLQ inspection and the methods on returned DLQ jobs use only the selected
broker. `createDlqJobMethods` resolves the embedded manager lazily inside
embedded branches; constructing TCP job methods must never initialize a local
database or consult an embedded data-path environment variable. The regression
`test/tcp-parity-queue-runtime.test.ts` exercises a real broker from a separate
client process and verifies both the returned DLQ state and absence of a local
client database.

`test/tcp-parity-queue-contract.test.ts` exercises the built `bunqueue-client`
package against the native Queue on one fresh TCP broker. It compares namespace
isolation, default job options, query ordering, group and global limits, log and
scheduler return shapes, and authoritative DLQ and metric results. This test
must run after building the SDK so the shipped exports and portable transport
are part of the evidence.

`QueueGroup.listQueuesAsync()` combines queues registered through the group
with matching queues from an already initialized embedded manager. It only
inspects the manager through `peekSharedManager`; listing remote queues must
not create an embedded runtime. The canonical package scenarios under
`sdk/typescript/tests/canonical-*.mjs` exercise the default public entry with
Node.js, Bun, and Deno. The Workers runner separately checks canonical Queue
and Flow routes while retaining historical SDK tests under the `/legacy`
export.

## Responsibilities & Scope

Owns:

- The stable `Queue<T>` façade and inherited capability chain under `queue/runtime/`.
- Constructor/state wiring in `runtime/state.ts`, transport cleanup in `runtime/connection.ts`, and per-concern contexts consumed by thin operation modules.
- Job-add option translation: merging `defaultJobOptions`, injecting `__parentId`/`__parentQueue` into data, mapping public `JobOptions` to the embedded `manager.push` shape and to the compacted `PUSH`/`PUSHB` wire payload (`add.ts`).
- Constructing the public `Job<T>` object via three builders — `createJobProxy` (TCP single add), `createSimpleJob` (embedded + TCP query results), and `toPublicJob`/`createPublicJob` (`jobProxy.ts`, `jobConversion.ts`). Conversion helpers receive grouped presentation metadata, including the effective `group.priority`, so name, data, priority, result, failure, token, and serialization fields cannot drift between construction paths.
- Auto-batching `add()` calls into `PUSHB` in TCP mode (`addBatcher.ts`).
- Reporting the failures of fire-and-forget commands sent by the synchronous
  mutators (`backgroundCommand.ts`; see "Background command failures" below).
- BullMQ Pro-compatible group admission and broker-authoritative group reads,
  overrides, pause/resume, and cleanup (`operations/groups.ts`,
  `runtime/queries.ts`).
- `QueueEvents`, the read-only embedded/TCP lifecycle-event listener
  (`events.ts`, `queue-events/tcpSubscription.ts`).
- The one job wait behind `Queue.waitJobUntilFinished` and every
  `Job.waitUntilFinished` — jobs from `add`/`addBulk`, queries, FlowProducer,
  DLQ entries, and Worker/SandboxedWorker events (`client/jobWait.ts`, with
  `client/job-wait/`: `session.ts`, `readers.ts`, `managerDispatch.ts`,
  `emitterDispatch.ts`, `brokerWait.ts`, `holdLimiter.ts`, `readScheduler.ts`,
  `types.ts`; the deadline timer is `safeDeadline` from
  [`shared/timers.ts`](./shared-timers.md)).
- BullMQ-compatible error classes `UnrecoverableError` / `DelayedError` (`errors.ts`).

Does NOT own:

- Job consumption / processing — see [Client SDK: Worker](./client-worker-sdk.md).
- The actual queue engine, state transitions, and persistence — see [Core Queue Engine](./core-queue-engine.md), [Job Lifecycle](./job-lifecycle.md), [Persistence](./persistence.md). `Queue` only forwards to `getSharedManager()` (embedded) or sends commands.
- TCP framing, pooling, reconnect, and the auto-batch transport mechanics — see [Client Transport](./client-transport.md).
- Server-side command handling — see [TCP Server Command Handlers](./tcp-server-handlers.md).
- DLQ, scheduler/cron, dedup, rate-limit, flow logic — delegated to sibling operation modules under `src/client/queue/` (`dlq.ts`, `scheduler.ts`, `deduplication.ts`, `rateLimit.ts`, `bullmqCompat.ts`); documented in [Dead Letter Queue](./dead-letter-queue.md), [Scheduler & Cron](./scheduler-and-cron.md), [Deduplication & Unique Jobs](./deduplication-and-unique.md), [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md), [FlowProducer & Job Dependencies](./flow-producer.md).
- Store-and-forward (`forward()` returns a `Forwarder`) — see [Store-and-Forward & BullMQ Compatibility](./store-and-forward.md).

## Dependencies

Internal:

- `getSharedManager(dataPath?)` — process-wide `QueueManager` singleton; lazily created, env-var data path resolution `BUNQUEUE_DATA_PATH > BQ_DATA_PATH > DATA_PATH > SQLITE_PATH`, with a programmatic `dataPath` override. The first effective path is canonicalized and retained; a later explicit path must identify the same database or construction throws synchronously. See [Core Queue Engine](./core-queue-engine.md), [Configuration & Entrypoint](./configuration.md).
- `TcpConnectionPool`, `getSharedPool`, `releaseSharedPool` — TCP transport. See [Client Transport](./client-transport.md).
- `AddBatcher` — concurrent `add()` batching into `PUSHB` (`addBatcher.ts`).
- `resolveToken`, `Forwarder`, operation modules (`operations/*`, `stall`, `dlq`, `rateLimit`, `scheduler`, `deduplication`, `jobMove`, `jobWait`, `workers`, `bullmqCompat`).
- `jobId()` from `src/domain/types/job` (string → internal job id), `pausedView` from `src/shared/pausedView`, `shardIndex` from `src/shared/hash`.

External / runtime: Bun only (`import '../require-bun'` guard in `index.ts:23`), `Bun.env`, Node `events.EventEmitter` (for `QueueEvents`). No third-party runtime deps.

## Public Interface

`new Queue<T>(name: string, opts: QueueOptions = {})` — exported from
`src/client/index.ts` (and `bunqueue/client`). The server-side key is
`prefixKey + name`; `queue.name` stays the logical name
(`queue/runtime/state.ts`).

Add (`queue/runtime/queries.ts`, `queue/operations/add/`):

- `add(name: string, data: T, opts?: JobOptions): Promise<Job<T>>` — routes
  through `AddBatcher` unless `opts.durable` or batching is disabled.
- `addBulk(jobs: Array<{ name; data: T; opts? }>): Promise<Job<T>[]>`

Query (`queue/runtime/queries.ts`, `queue/operations/query.ts`): `getJob`,
`getJobState`, `getChildrenValues`, `getJobs(opts?)` / `getJobsAsync(opts?)`, and
per-state pairs `getWaiting`/`getWaitingAsync`, `getDelayed[Async]`,
`getActive[Async]`, `getCompleted[Async]`, `getFailed[Async]`. **Sync variants
return `[]` in TCP mode**; use the `Async` form over TCP.

For all list methods, `end: -1` means exhaustive traversal. Embedded queries
pass an effectively unbounded end to the manager; TCP queries page in chunks of
1,000 until exhaustion (`queryTcpPages.ts`). Explicit finite ends retain the
existing half-open `[start,end)` contract. Per-state aliases live in
`queryStates.ts` so the generic conversion/query module stays within the
repository size boundary. `getJobs[Async]({ asc: false })` applies descending
createdAt/job-id order before slicing, in both runtimes and on every TCP page.

Counts (`queue/runtime/queries.ts`, `queue/operations/counts.ts`):
`getJobCounts()` / `getJobCountsAsync()`, `getWaitingCount`, `getActiveCount`,
`getCompletedCount`, `getFailedCount`, `getDelayedCount`, `count()` /
`countAsync()`, `getCountsPerPriority()` / `getCountsPerPriorityAsync()`. Sync
`count()` / `getCountsPerPriority()` return `0` / `{}` over TCP.

Group methods (`queue/runtime/queries.ts`, `queue/operations/groups.ts`) are
asynchronous in both runtimes: `getGroupJobsCount`, `getGroupsJobsCount`,
`getGroupActiveCount`, `getGroupJobs`, `getCountsPerPriorityForGroup`,
`setGroupRateLimit`, `getGroupRateLimit`, `removeGroupRateLimit`,
`getGroupRateLimitTtl`, `setGroupConcurrency`, `getGroupConcurrency`,
`removeGroupConcurrency`, `pauseGroup`, `resumeGroup`, and `isGroupPaused`.
The list/count helpers cover pending grouped jobs (waiting, prioritized, and
delayed), while active depth is separate. Public `JobOptions.group` accepts
`{ id, priority?, maxSize? }`: `priority` is an integer from 0 through
2,097,151 with lower values served first inside the group; `maxSize` makes the
pending-depth admission check atomic for single, bulk, and flow adds.

Control (`queue/runtime/control.ts`, `queue/operations/control.ts`): `pause()`,
`resume()`, `drain()`, `obliterate()` (all sync, fire-and-forget; a failure is
reported, see "Background command failures"),
`pauseAsync()`, `resumeAsync()`, `drainAsync()` (resolves with the removed
count), `obliterateAsync()`, `isPaused()` / `isPausedAsync()`,
`waitUntilReady()`.

The async control variants resolve only after the server has processed the command; `drainAsync()`/`retryDlqAsync()`/`purgeDlqAsync()` also return the server count that the fire-and-forget forms discard (they always return 0 over TCP).

`obliterateAsync()` resolves only after the server has processed the wipe. The fire-and-forget `obliterate()` gives no ordering guarantee over the multi-connection TCP pool (default 4 sockets, round-robin): a `PUSH` sent right after it can travel on a different socket, be processed first, and then be wiped by the late-arriving obliterate, even with a sleep in between, if the server event loop is busy. Await `obliterateAsync()` before enqueuing follow-up jobs on the same queue (`control.ts:44`).

Management (`queue/runtime/control.ts`, `queue/operations/management.ts`):
`remove(id)` (sync) / `removeAsync(id)`, `retryJob(id)`, `retryJobs(opts?)`,
`clean(grace, limit, type?)` / `cleanAsync(...)`, `promoteJobs(opts?)`,
`promoteJob(id)`, `updateJobProgress`, `getJobLogs`, `addJobLog`,
`clearJobLogs`, `updateJobData`, `changeJobDelay`, `changeJobPriority`,
`extendJobLock`.

DLQ configuration (`queue/runtime/configuration.ts`) also exposes
`removeDlqJob(id)` and `removeDlqJobAsync(id)`, both returning
`Promise<boolean>`. They permanently delete only the selected failed job,
return `false` for an idempotent miss, and propagate embedded persistence or
TCP broker errors instead of treating them as misses.

`retryJobs({ state, count, timestamp })` supports both declared states. `failed`
retries matching DLQ entries and `completed` re-queues completed jobs; `count`
is a non-negative cap and `timestamp` includes only entries whose terminal
timestamp is at or before the cutoff. Embedded and TCP paths apply the same
selection rules.

`promoteJobs({ count? })` delegates to the manager/server bulk operation in both
embedded and TCP modes; `count: 0` promotes none. In memory/SQLite mode it
selects delayed jobs from the live shard queue in stable `(createdAt, id)` order
rather than from SQLite's eventually consistent `GetJobs` view, then updates the
priority queue, delayed counter/temporal tracking, persisted `run_at`, and queue
waiter notification before resolving. In PostgreSQL mode it locks the selected
rows in `(created_at, id)` order with `FOR UPDATE SKIP LOCKED`, updates `run_at`
and state, and records durable events in one transaction before refreshing the
broker projection.

Move / BullMQ-v5 (`queue/runtime/scheduling.ts`, `queue/jobMove.ts`):
`moveJobToCompleted`, `moveJobToFailed`, `moveJobToWait`,
`moveJobToDelayed`, `moveJobToWaitingChildren`, and `waitJobUntilFinished`,
which delegates to the shared `client/jobWait.ts` (see Edge Cases).
`moveJobToFailed(id, error)` forwards the error's stacktrace (#74) and honours
`UnrecoverableError` (skip retry) via the shared `failWire` helper, matching the
worker failure path. `moveJobToDelayed(id, timestamp)` takes an **absolute**
timestamp; embedded routes waiting/active jobs via
`changeWaitingDelay`/`changeDelay`, while the TCP path sends `MoveToDelayed`
with `delay = max(0, timestamp - now)` and surfaces `ok:false` as an error.
Both modes first check the arguments with the broker's validators
(`queue/commandArgs.ts`): `moveToDelayed` needs a finite `timestamp` or its plain decimal string (a past one means
now), `changeJobDelay`/`job.changeDelay` a finite `delay` (a negative one makes the job
ready at once with a past run time, as on 2.9.10), and `extendJobLock`/`job.extendLock` a finite `duration` (any
sign, as the broker applies it; `extendLock(token, 0)` resolves 0, as on 2.9.10). They
throw the message a TCP command returns for NaN or an infinity, because several TCP
paths ignore the reply.
`changeJobDelay`, `changeJobPriority` and `extendJobLock` live in
`queue/operations/jobSetters.ts` (re-exported by `management.ts`). Every TCP
`changePriority`/`changeJobPriority` path reads the reply (`assertPriorityChanged`): a
job that is not queued is not changed, as in embedded mode, and any other rejection (a
NaN or non-numeric priority) throws; the reply used to be ignored. A missing priority is
0 and a non-boolean `lifo` is normalized to a boolean, as on PUSH. `updateProgress` goes
through `progressUpdate` (`normalizeProgress`) on every job object and never throws for
the value: object progress is sent as `0` plus its JSON as the message (as
`Queue.updateJobProgress` and flow jobs already did), NaN is 0, `'50'`/`true`/`null` are
50/1/0 and other text is 0 with the text as the message, as 2.9.10 stored them.
`clearJobLogs`/`job.clearLogs` read the `ClearLogs` reply on every TCP path
(`assertLogsCleared`), so an invalid `keepLogs` throws the broker's message as it does
embedded, and the TCP Job from `Queue.add` forwards `keepLogs` (it used to drop it and
clear every entry). `updateJobData` throws the broker's message for a job it cannot
update, while `changeJobDelay`, `promoteJob`, `updateJobProgress` and `changeJobPriority`
resolve without change, in both modes (2.9.10's result), and every TCP path reads the
reply; see the setter outcome table in [Job Options Validation](./job-options-validation.md).
`updateJobProgress` maps progress with `progressUpdate` like the job objects and never
throws for the value. `upsertJobScheduler` reports a refused schedule as 2.9.10 did:
embedded mode throws the reason, TCP mode resolves `null`.

Stall and DLQ configuration live in `queue/runtime/configuration.ts`, backed by
`queue/stall.ts`, `queue/dlq.ts`, and `queue/dlqOps.ts`:
`setStallConfig[Async]`, `getStallConfig[Async]`, `setDlqConfig[Async]`,
`getDlqConfig[Async]`, embedded snapshot reads `getDlq` / `getDlqStats`, and
authoritative cross-runtime reads `getDlqAsync(filter?)` /
`getDlqStatsAsync`. Retry and purge have both fire-and-forget and acknowledged
forms. Rate-limit methods include setters/removers, `rateLimit(expireTimeMs)`,
and live getters in both runtimes. Scheduler and compatibility methods are in
`runtime/scheduling.ts` and `runtime/compatibility.ts`.

`QueueGroup` keeps track of queues created through the group. Its synchronous
bulk methods operate on the embedded manager; `listQueuesAsync`,
`pauseAllAsync`, `resumeAllAsync`, `drainAllAsync`, and `obliterateAllAsync`
are the authoritative operations for either runtime. `drainAllAsync` returns
the aggregate removed count.

Connection: `disconnect()` (flushes + waits for the in-flight batcher, then
closes) and `close()` (`queue/runtime/connection.ts`). Both operations are
idempotent at the Queue ownership boundary: a TCP pool reference acquired by
the constructor is released exactly once. Repeated `close()` calls, including
`disconnect()` followed by `close()`, therefore cannot close a shared pool
still owned by another Queue.

In embedded mode `close()` (and therefore `disconnect()`) also flushes the
shared manager's SQLite write buffer before returning, so a job whose `add()` or
`addBulk()` resolved survives an immediate `process.exit()`. It calls
`peekSharedManager()?.flushPendingWrites()`: it never creates a manager, is a
no-op after `shutdownManager()`, for an in-memory manager and for PostgreSQL
(which returns `0`), and leaves the manager and its timers running, so
`shutdownManager()` is still what lets the process exit. The flush is best
effort and uses the buffer's backoff-aware gate (`flushIfReady`), not the
snapshot flush (`flushPersistence()`, which throws and bypasses backoff):
`close()` stays synchronous and never throws, and while a write retry backoff is
armed it writes nothing and makes no insert attempt, so closing queues cannot
spend the buffer's retry budget. Rows it leaves buffered stay under the
`WriteBuffer` retry and critical-loss handling and are written by the scheduled
retry. TCP queues do not touch the embedded manager. Pinned by
`test/repro-embedded-close-exit-loses-buffered-jobs.test.ts`,
`test/repro-embedded-close-respects-writebuffer-backoff.test.ts` and
`test/embedded-queue-close-flush.test.ts`.

Also exported: `QueuePro` (the `Queue` implementation), `QueueEventsPro` (the
`QueueEvents` implementation), the type alias `JobPro<T>`,
`QueueEvents<R, P>`, `QueueEventsOptions`, `QueueMetrics`,
`QueueMetricsMeta`, `QueueMetricType`,
`UnrecoverableError`, and `DelayedError`.

`new QueueEvents(name, options?)` preserves the historical no-options embedded
default. Pass `{ embedded: false, connection }` (or simply `{ connection }`) for
broker events. TCP mode owns one dedicated authenticated subscription socket,
re-subscribes after reconnect, filters by the prefixed queue key, and is ready
only after the broker acknowledges `SubscribeEvents`.

TCP commands emitted by this module (exact names): `PUSH`, `PUSHB`, `GetJob`, `GetState`, `GetChildrenValues`, `GetJobs`, `GetJobCounts`, `GetCountsPerPriority`, `Count`, `Pause`, `Resume`, `Drain`, `Obliterate`, `IsPaused`, `Ping`, `Cancel`, `MoveToWait`, `MoveToWaitingChildren`, `RetryDlq`, `RetryCompleted`, `GetDlqStats`, `Clean`, `Promote`, `PromoteJobs`, `Progress`, `GetLogs`, `AddLog`, `ClearLogs`, `Update`, `ChangeDelay`, `ChangePriority`, `ExtendLock`, `ACK`, `FAIL`, `MoveToDelayed`, `WaitJob`, `SetStallConfig`, `GetStallConfig`, `GetQueueLimits`, `GetGroupJobsCount`, `GetGroupsJobsCount`, `GetGroupActiveCount`, `SetGroupRateLimit`, `GetGroupRateLimit`, `RemoveGroupRateLimit`, `GetGroupRateLimitTtl`, `SetGroupConcurrency`, `GetGroupConcurrency`, `RemoveGroupConcurrency`, `PauseGroup`, `ResumeGroup`, `IsGroupPaused`, `GetDeduplicationJobId`, `RemoveDeduplicationKey`, `RemoveJobDeduplicationKey`, `ListWorkers`, `Metrics`, `TrimEvents`, `GetResult`, `GetFailedChildrenValues`, `GetIgnoredChildrenFailures`, `RemoveChildDependency`, `RemoveUnprocessedChildren`, `Discard`, `SubscribeEvents`, `UnsubscribeEvents`.

`QueueEvents` events emitted: `waiting`, `active`, `completed`, `failed`, `progress`, `stalled`, `removed`, `delayed`, `duplicated`, `retried`, `waiting-children`, `drained`, `paused`, `resumed`, `error` (`events.ts:150`). `failed` fires for every failed attempt; its payload's `terminal` flag is `false` while a retry is pending and `true` once the job failed for good.

## Data Models

See [data-model](../data-model.md) for full definitions. Public types are split
by responsibility under `src/client/types/`:

- `Job<T>`, `JobStateType`, `JobJson`, and `JobJsonRaw`:
  `client/types/job.ts`.
- `JobOptions`, backoff, repeat, deduplication, debounce, and parent options:
  `client/types/options.ts`.
- `QueueOptions`, `ConnectionOptions`, and `AutoBatchOptions`:
  `client/types/connection.ts`.
- `StallConfig`: `client/types/worker.ts`; DLQ types:
  `client/types/dlq.ts`; `FlowJobData`: `client/types/flow.ts`.
- Queue metric response and state discriminator types: `client/types/metrics.ts`.
- `QueueEventsOptions` and typed event payloads: `client/types/events.ts`.
- Queue-internal contexts, reflection metadata, and runtime contracts:
  `client/queue/types/`.

## Business Logic / Control Flow

**Construction** (`queue/runtime/state.ts`): `embedded = opts.embedded ??
FORCE_EMBEDDED` (`FORCE_EMBEDDED` lives in `queue/helpers.ts`). In TCP mode,
`rejectLegacyConnectionOptions()` (`client/legacyConnectionOptions.ts`) then
throws before any pool is created if the options carry a defined top-level
`host`, `port`, `token`, or `tls` (the flat bunqueue-client 0.1.x shape): those
keys are never read, so the queue would otherwise connect to `localhost:6789`
without the intended token or TLS. The message names the keys and points to
`connection: { host, port, token, tls }`. Embedded mode
warms `getSharedManager(opts.dataPath)` and leaves `tcpPool` / `addBatcher`
null. TCP mode reuses the shared pool for the default unauthenticated
four-connection case, otherwise creates a dedicated `TcpConnectionPool`. The
`AddBatcher` is created unless batching is disabled; `resolveAutoBatchConfig`
(`addBatcher.ts`) resolves the options, keeping every result 2.9.10 had:

- `enabled`: a boolean, or a recognized word or number with its meaning (`'false'`,
  `0`, `'0'` disable; `'true'`, `1`, `'1'` enable; any case, trimmed). `null` and
  `undefined` mean enabled. Anything else keeps batching enabled, the 2.9.10 result
  (it disabled only for `false`), and logs one `console.warn` naming the value.
- `maxSize` (default 50): the flush threshold is `pending >= maxSize`, so a value below
  1 flushes every add, as 1 does, and is stored as 1; a fraction rounds up; `Infinity`,
  NaN or a non-number (`pending >= NaN` is never true) and a value above
  `Number.MAX_SAFE_INTEGER` never flush by size and are stored as `Infinity` (the idle
  flush, the `maxDelayMs` window and the 10000-entry `maxPending` bound still apply).
- `maxDelayMs` (default 5): a finite number >= 0, honoured exactly even beyond the
  native timer limit. A negative value, NaN, `Infinity` or a non-number is 0: 2.9.10's
  timer ran each of them after ~1 ms, an immediate flush.
- A numeric string (plain decimal digits) is that number (`tcp/numeric.ts`). Nothing
  in `autoBatch` throws.

With `enabled: false` (or its word) the other two are not read. Embedded mode does not
read `autoBatch`.

The embedded manager is process-wide. Its first effective `dataPath` is
resolved to a canonical absolute file identity (`:memory:` remains a distinct
SQLite in-memory identity). Later clients that omit `dataPath` join that
manager without re-reading environment variables. A later explicit path that
does not identify the active database throws before the client is constructed;
it is never silently ignored. Relative, absolute, and symlink spellings of the
same existing database are accepted. To switch databases, close every embedded
client and call `shutdownManager()` first. Concurrent databases require
separate processes or TCP brokers.

**add()** (`queue/operations/add/single.ts`): merges `defaultJobOptions` then
per-call `opts`, validates the bounded options with the broker's
`validateJobOptions` under their wire names (`add/validation.ts`, see
[Job Options Validation](./job-options-validation.md)) and throws the same message
a TCP `PUSH` returns, injects `__parentId` / `__parentQueue` when a parent is set,
and maps to `manager.push` in embedded mode. In TCP mode `Queue.add` runs the same
check before handing the add to the `AddBatcher`, so an invalid add rejects on its
own instead of failing its whole `PUSHB` batch. TCP uses `buildPushPayload` from
`add/payload.ts`, throws on `!response.ok`, and builds a live job through the
split proxy modules under `queue/job-proxy/`. A `parent` option is authoritative:
the broker locks both queue shards, persists the child and parent edge together,
and moves the existing pending parent to `waiting-children` before the child is
visible. A non-linkable parent rejects the add without publishing the child.

**addBulk()** (`queue/operations/add/bulk.ts`): returns `[]` immediately for an
empty input and merges defaults once per job, then validates every job and throws
`jobs[i]: <error>` (the `PUSHB` message) before anything is sent or admitted. Embedded uses
`manager.pushBatch`; TCP sends one `PUSHB`. A non-ok response throws so the
batcher rejects every caller; an ok response with zero IDs is a legitimate
empty result. Parent references are preflighted for the complete batch while
all affected shards are locked, preventing an invalid later item from leaving
an accepted prefix. Multiple children of one cross-queue parent are serialized
under that parent's shard lock, so concurrent adds cannot overwrite an edge.

**Job object construction.** `queue/job-proxy/tcp.ts` builds a TCP-backed job;
`queue/job-proxy/simple.ts` builds the dual-mode form used by query results;
`queue/job-proxy/reflection.ts` derives reflected option fields. The job returned by
`add`/`addBulk` reflects its options through `reflectionMeta`
(`queue/operations/add/payload.ts`), which reports a negative `delay` as 0 in
`job.delay` and `job.opts.delay`, as a job read back from the broker does (the broker
keeps the past run time, so the job is ready at once in both modes, see
[Job Options Validation](./job-options-validation.md)).
Public conversion lives in `client/jobConversion.ts`. Full DLQ entries use
`queue/dlqJobMethods.ts` so broker-returned jobs keep live methods rather than
detached placeholders. Each of these builders, the FlowProducer job
(`client/flowJobMoveMethods.ts`), and Worker/SandboxedWorker event jobs
(`worker/handlers/dependencies.ts`) delegate `waitUntilFinished` to
`client/jobWait.ts`, so every Job waits with the same semantics.

**getJob()** (`query.ts`): embedded uses full `toPublicJob` wiring when
`ctx.updateJobData` is present (all callbacks route to the shared manager); TCP
sends `GetJob` and returns null on `!ok`. The single `metadataFromJob` reflection
path now supplies `attemptsMade`, `attemptsStarted`, `stalledCounter`, progress,
priority, `processedOn`, `finishedOn`, options, stacktrace, return value, and
failure reason to both `getJob()` and `getJobs[Async]()`. Its options come from
`buildJobOpts` (`client/jobHelpers.ts`), which reflects an object backoff as
`{ type, delay, maxDelay? }` and adds `maxDelay` only when the job has one, so
`job.opts.backoff` round-trips the caller's cap. Jobs delivered to a TCP worker
are parsed by `worker/jobParser.ts`, which also reads the `backoffConfig` the
server already includes in every pulled job (`null` for a numeric backoff), so
`job.opts.backoff` round-trips there too. The live properties,
`toJSON()`, and `asJSON()` therefore describe the same broker generation in
embedded and TCP mode instead of query proxies resetting lifecycle counters to
zero.

**getJobState() / mapState()** (`query.ts:169`): normalizes server/manager states — `processing → active`, `dlq → failed`, unknown → `unknown` (`query.ts:180`).

**Counts.** `getJobCounts()` returns synchronously only in embedded mode; in TCP mode it delegates to `getJobCountsAsync()` so callers get real counts, not zeros (`counts.ts:33`). Embedded applies `pausedView`: when paused, ready jobs (waiting + prioritized) are reported under `paused` to avoid double-counting (`counts.ts:44`, #92).

**Stall config** (`stall.ts`): embedded writes through to `dlqOps`; TCP sends `SetStallConfig` and keeps a client-side `tcpConfigCache` so the sync `getStallConfig()` returns the last-set value (server remains source of truth; use `getStallConfigAsync()` for the authoritative value, `stall.ts:24`, `stall.ts:48`).

## Concurrency & Locking

`Queue` itself takes no shard/job locks; in embedded mode all locking happens inside `QueueManager` (see [Concurrency & Locking](./concurrency-and-locking.md)). The client-side concurrency surface is the `AddBatcher`:

- **Strategy** (`addBatcher.ts`): if no flush is in flight, flush immediately (zero latency for sequential `await`); if a flush is in flight, buffer until `maxSize` or a `maxDelayMs` timer fires. The window timer is a `safeTimeout`, so a `maxDelayMs` above 2^31 - 1 ms no longer fires after ~1 ms. After each flush completes, accumulated items are drained immediately (`doFlush` loops while `pending.length > 0`, `addBatcher.ts:108`).
- **In-flight tracking**: `triggerFlush` registers each flush promise in
  `inFlightFlushes`; `disconnect()` in `queue/runtime/connection.ts` calls
  `flush()` then `waitForInFlight()` before closing.
- **`removeAsync` ordering invariant** (`management.ts:26`): the embedded path *must* `await manager.cancel()` because the removal happens inside an async write-lock; without the await the promise would resolve before the job is gone and cancel errors would be swallowed — divergent from the TCP path.

## Edge Cases & Failure Modes

- **Durable bypass**: `opts.durable` jobs skip the `AddBatcher` in
  `queue/runtime/queries.ts` and are sent as individual `PUSH` operations.
- **Batcher overflow**: when `pending.length >= maxPending` (default `10000`), the oldest ~10% are spliced and rejected with `"Add buffer overflow - oldest entries dropped"` (`addBatcher.ts:69`). `stop()` rejects all remaining entries with `"AddBatcher stopped"`.
- **Error propagation**: `add`/`addBulk` throw on `!response.ok`, ensuring the
  batcher rejects queued callers (e.g. auth failure) rather than resolving them
  with `undefined` jobs (`operations/add/single.ts:109-113`,
  `operations/add/bulk.ts:130-133`).
- **Background command failures** (`backgroundCommand.ts`): the synchronous
  mutators cannot await their round trip, so they send through
  `sendInBackground` (or `runInBackground` for embedded `cancel`/`discard`
  promises). This covers `pause`, `resume`, `drain`, `obliterate`, `remove`,
  `setStallConfig`, `setDlqConfig`, `retryDlq`, `retryDlqByFilter`, `purgeDlq`,
  `retryCompleted`, `setGlobalConcurrency`, `removeGlobalConcurrency`,
  `setGlobalRateLimit`, `removeGlobalRateLimit`, and `job.discard()` on every job
  builder, including DLQ entries. A rejection (broker unreachable, `Command
  timeout` after `commandTimeout`, `Connection pool is closed` for a call made
  after `close()`, or an embedded lock or storage error) never becomes an unhandled
  rejection, which would end a Bun process. It becomes a `BackgroundCommandError`
  (`name` `BackgroundCommandError`, `context` `'background-command'`, `command` (the
  TCP command name, `Cancel`/`Discard` for embedded ones), `queue` (the prefixed
  key), and `cause`). That error goes to the Queue's background-error listener
  when one takes it: `Queue` has no `error` event of its own, so only Simple Mode
  registers one, through `setBackgroundErrorListener` (a `WeakMap` keyed by the
  Queue, consulted when the failure arrives through the stable
  `onBackgroundError` router that `runtime/state.ts` puts on every operation
  context). Otherwise it becomes one `console.error` line:
  `[bunqueue] <command> for queue "<queue>" failed in the background: <reason>`.
  If the listener throws, the line also names the listener's error. Reporting
  never throws. A `ClientClosedError` (the command was still pending when the
  caller closed the client) is not reported, matching the process-wide filter in
  `tcp/errors.ts`. A server reply with `ok: false` is not a rejection and stays
  ignored by these forms. The `...Async` variants are unchanged: they reject to
  their caller, so use them when the outcome matters.
- **Synchronous TCP boundaries**: `getJobs`/`getWaiting`/… (sync) return `[]`, `count()` returns `0`, `getCountsPerPriority()` returns `{}`, and `isPaused()` returns `false` in TCP mode because their signatures cannot await a round trip. Use the corresponding `Async` variants for authoritative remote results. The same rule applies to synchronous DLQ reads and fire-and-forget mutation forms; use `getDlqAsync`, `getDlqStatsAsync`, `retryDlqAsync`, `retryDlqByFilterAsync`, `purgeDlqAsync`, and `retryCompletedAsync` when the result matters. Selective `removeDlqJob` is deliberately Promise-based even without the suffix, and `removeDlqJobAsync` is its explicit alias. Limit getters, worker discovery, dependency methods, deduplication methods, and `moveToWaitingChildren` are asynchronous and now query or mutate the selected broker runtime directly.
- **Detached conversion helpers**: broker-returned `Job` instances always receive a complete live operation context. Low-level callers that invoke `createPublicJob` without a context receive only detached fallback behavior and must not treat that helper as a broker client.
- **Idempotency**: `jobId`/`deduplication.id` make `add` idempotent (custom-id dedup, server-side, only while the job is live: completion or the DLQ releases the id). `forward()` uses deterministic remote ids (`fwd:<queue>:<localId>`) so re-forwards don't duplicate (see [Store-and-Forward](./store-and-forward.md)).
- **Metrics/event retention**: `getMetrics(type,start,end)` returns queue-scoped,
  newest-first one-minute buckets over identical embedded/TCP paths.
  `trimEvents(maxLength)` returns the exact number removed from that queue's
  separate persistent event journal; repeated trims are idempotent.
- **`retryJob` state machine** (embedded, `management.ts:40`): `failed` → `retryDlq` (throws if not in DLQ), `active` → `moveActiveToWait`, `waiting`/`prioritized`/`delayed` → no-op, anything else throws. TCP path issues `MoveToWait` and throws on `ok !== true`.
- **Waiting for a job** (`client/jobWait.ts`, `client/job-wait/`):
  `Queue.waitJobUntilFinished(id, queueEvents, ttl?)` and every
  `Job.waitUntilFinished(queueEvents, ttl?)` share BullMQ v5 semantics in both
  runtimes. The wait resolves with the result once the job completes, including
  on a later attempt; rejects with the final attempt's failure reason
  (`job.failedReason`, falling back to `Job already failed`) once the job failed
  for good (no retry left, moved to the DLQ by a failure, a stall or a lock
  expiry); ignores `failed` events with `terminal: false`; and rejects with a
  timeout only when the TTL elapses first. A `failed` payload without `terminal`
  (a mock emitter, or a broker older than 2.8.56) still settles it.
  - **TTL**: a positive finite TTL bounds the wait. Any other value (`0`, a
    negative number, `NaN`, `Infinity`) means no timeout, with or without
    QueueEvents. An omitted (or `null`) TTL means no timeout with QueueEvents,
    as in BullMQ, and `30000ms` without. The deadline is a timer of its own, so a
    wait is never held past it by a command that cannot complete (an unreachable
    broker). When it fires, the wait reads the job once more if the read budget
    (below) has a token, for at most 1 s, and settles on the outcome if the job
    finished unseen; otherwise it rejects with `Job <id> timed out after <ttl>ms`
    (with QueueEvents) or `waitUntilFinished timed out after <ttl>ms` (without).
    A TTL of any length holds: Bun and Node.js accept a timer delay of at most
    2^31 - 1 ms (about 24.8 days) and fire a longer one after 1 ms, so the
    deadline (an absolute epoch-ms `WaitLimit.deadline`) is armed with
    `safeDeadline` ([Shared Timers](./shared-timers.md)) in chunks of at most
    2^31 - 1 ms. Each chunk, the last one included, measures what remains
    against `Date.now()`, so clock drift does not accumulate across chunks and
    the deadline never fires early; the session keeps the chunk armed now, and
    settling clears it (`test/job-wait-long-deadline.test.ts`,
    `test/repro-wait-long-ttl.test.ts`).
  - **Embedded**: every wait registers with one subscription per manager
    (`job-wait/managerDispatch.ts`, a `Map<jobId, Set<watcher>>` created by the
    first wait, released by the last, dropped with its manager), so N waits cost
    O(1) per event. The job's `completed` and terminal `failed` events settle it;
    `stalled` and `removed` make it re-read the state. It reads the job once right
    after subscribing (the subscription is synchronous, so no transition is
    missed). Reads use `peekSharedManager()` and never create a manager: a wait
    started after `shutdownManager()` rejects at once, and `shutdownManager()`
    rejects every pending wait on the stopped manager (`onSharedManagerShutdown`),
    both with `waitUntilFinished: the embedded engine was shut down`. A
    QueueEvents passed in embedded mode is listened to as well, but adds nothing
    the manager does not already report.
  - **TCP with QueueEvents** (or any object with `on`/`off` and the same
    payloads): waits on one emitter share its listeners and one readiness round
    trip (`job-wait/emitterDispatch.ts`; a TCP QueueEvents answers
    `waitUntilReady()` with a Ping that counts toward its connection's rate
    limit). The wait reads the state (`GetState`, plus `GetResult` or `GetJob`
    for the reason) once the QueueEvents is ready, which closes the window in
    which a job finishing while it subscribes would be missed. `stalled` and
    `removed` events for the job trigger an immediate re-read; the internal
    `resubscribed` signal after the QueueEvents reconnected
    (`queue-events/streamSignals.ts`; events sent while it was down are lost)
    queues one re-read per wait within the read budget. When the QueueEvents
    closes (`close()`/`disconnect()`, a `closed` signal) or cannot become ready,
    the wait continues without it as below, keeping its deadline and timeout
    message.
  - **TCP without QueueEvents** (`job-wait/brokerWait.ts`, `holdLimiter.ts`):
    after the first state read, the wait reads the job on the `BROKER_READS`
    schedule (1 s, then 2 s, 4 s ... and every 30 s), which reports failures,
    since `WaitJob` settles only on completion. Meanwhile, with a hold slot, it
    holds `WaitJob` for 1 s, then 2 s, 4 s ... up to 30 s per hold (never past
    the TTL, so always inside the broker's `[0, 600000]` bound) and settles at
    once on a completion. The broker runs at most 50 commands per connection at
    once and a hold keeps one of them: uncapped, more than about 50 waits per
    connection took every slot, other commands queued behind the holds (a
    `getJobCounts` probe took 5 s and more), and queued holds overran their
    timeout and forced reconnects. Hold slots are therefore leased per
    connection (`TcpConnectionPool.reserveLongPoll`, `tcp/longPollRouter.ts`):
    at most `HOLDS_PER_CONNECTION` (40) on each connection of the pool, never
    more than half of its `maxInFlight` window, on the connection with the
    fewest (a pool of 4 connections splits commands evenly, so a default pool
    holds up to 160). A wait keeps its slot across holds until it settles, and
    slots pass on in FIFO order, as the broker's own queue did when every wait
    held `WaitJob`: since jobs mostly finish in the order they were added, a
    queued wait usually holds by the time its job completes. A wait that held
    for 30 s (`HOLD_TURN_MS`) while others queue yields its slot. Until it gets
    a slot, a wait learns of a completion from its scheduled reads; with more
    concurrent waits than slots and jobs that do not finish in order, that can
    take seconds (see Limitations), so use `QueueEvents` for high-concurrency
    request/response. Each hold runs under its own command timeout (hold + 5 s,
    `SendOptions.timeout`), so the connection's `commandTimeout` does not cut it
    short and a hold that the broker answers in time never counts toward the
    consecutive-timeout reconnect (see [Client Transport](./client-transport.md)).
    A reply before the hold ended is followed by an unref'd pause until its end,
    so a broker answering early cannot turn the loop into a busy one. TTLs above
    600000 ms are honoured by further holds.
  - **Read budget and safety net** (`job-wait/readScheduler.ts`): every
    background read (the safety net, the `BROKER_READS` schedule, the re-reads
    after a re-subscription, the read at the deadline) goes through a token
    bucket shared by all waits on one transport (`TCP_READS_PER_SECOND` = 20,
    about 12 % of one connection's default broker budget of 10,000 requests per
    60 s) or one embedded manager (1,000 per second). An event-driven wait
    (embedded, or TCP with QueueEvents) re-reads the job about 5 s after it
    starts, then after 10 s, 20 s and every 30 s; every delay is jittered by
    ±25 %, so waits started together do not read in the same tick. This covers
    outcomes with no job event (drain, obliterate, clean, DLQ purge, an event
    lost without a re-subscription). A wait that settles first reads nothing
    extra; with more waits than the budget covers (more than about 600 long
    waits per transport) each is read less often instead of the connection being
    flooded: 10,000 long waits are each re-read about every 8 minutes. The
    scheduler's timer is unref'd and never keeps the process alive; a TTL timer
    does, as before. Initial reads are not budgeted: N waits started at once
    still send N `GetState` commands, as before.
  - **A job that no longer exists** settles the wait with `Job <id> not found`
    in every path: removed, drained, obliterated, cleaned, purged from the DLQ,
    or removed on completion or failure (`removeOnComplete`/`removeOnFail`)
    before the wait saw that event, including a job missing when the wait starts
    (BullMQ rejects with "Missing key" there). The outcome of such a job is
    unknown, so the wait reports neither a result nor a failure reason. Over TCP
    a state read that finds no job first asks the broker's completion lookup
    (`WaitJob` with a 0 ms hold, the lookup a hold uses; `brokerReader` in
    `job-wait/readers.ts`). A broker that retains the completion of a job removed
    on completion (PostgreSQL keeps a completion tombstone) answers with the
    result, and the wait settles on it; `completed: false` (a job back under the
    same custom ID) keeps waiting, a transient refusal is retried, and any other
    reply counts as not found, as the state read did. The outcome depends on
    the broker's state only, not on whether a hold or a scheduled read reaches it
    first. Before, the read path said `not found` while a hold on the same broker
    returned the result: with 64 waits per connection and 40 hold slots, a queued
    wait whose read was served after the removal rejected
    (`postgres-public-api-extreme`, 256 remote waiters, flaked this way under
    load; `test/repro-job-wait-removed-on-complete.test.ts`). Memory and SQLite
    retain nothing for a job removed on completion, so such a job still settles
    as not found there. Over TCP with QueueEvents a `Job not found` read is then
    confirmed through a fresh `waitUntilReady()` round trip on the event
    connection, so a `completed` event already sent for a job removed on
    completion still wins.
  - **Errors**: a read that fails for a transient reason (the broker's
    `Rate limit exceeded`, `Command timeout`, `Connection lost`, `Not
    connected`; `isTransientError` in `job-wait/types.ts`) says nothing about
    the job and is retried by the next scheduled read, the first read included
    (HEAD's state read swallowed such a refusal; with 14,000 waits started on
    one connection, rejecting would have turned 4,000 of them into errors). Any
    other failure is final and rejects the wait: an `ok: false` reply to
    `GetState`, `GetResult` or `WaitJob` (for example `Not authenticated`), a
    closed pool after `queue.close()`. `GetJob` only supplies the failure
    reason, falling back to `Job already failed`. A broker outage longer than
    `commandTimeout` therefore no longer rejects a wait: it settles once the
    client has reconnected and sees the outcome (which can lag by the reconnect
    backoff, up to 30 s, plus the next scheduled read), or at its TTL.
  - **Limitations**: over TCP without QueueEvents a failure is reported by the
    next scheduled read: about 1 s after the start and at most about 37 s late
    after that while at most about 600 waits share the pool's read budget (20
    reads per second); beyond that, reads come less often (measured with 1,500
    failing jobs on one pool: median 36.7 s, max 74.3 s). A completion is seen at
    once by a wait holding a slot; with more concurrent waits than slots (40 per
    connection, 160 on a default pool of 4) and jobs that do not finish in the
    order their waits started, a queued wait can learn of it seconds later
    (measured on a default pool, 1 s jobs: 1,000 waits p90 2.0 s and max 5.1 s,
    1,200 waits p90 2.1 s and max 5.1 s; HEAD about 0 ms, since every wait held
    `WaitJob` on the broker) — use `QueueEvents` for high-concurrency
    request/response. Outcomes without a job event (drain, obliterate, clean,
    DLQ purge) surface at the next safety-net read. After a broker outage a wait
    settles once the client has reconnected, which can lag by the reconnect
    backoff (up to 30 s) plus the next scheduled read; in a 40 s outage the job
    acked 3 s after the broker returned resolved its waits 19 s later. A job
    removed on completion whose `completed` event the wait missed (it completed
    before the wait started, or while a TCP QueueEvents was disconnected)
    reports `Job <id> not found` on memory and SQLite, because its result is not
    retained; over TCP to a PostgreSQL broker it settles on the retained result. A
    `QueueManager` shut down directly (`manager.shutdown()` instead of
    `shutdownManager()`) sends no shutdown signal, so its waits settle from their
    next read. An emitter whose `on()` throws for an event name loses only that
    hint. A wait without a TTL does not keep the process alive by itself (its
    timers are unref'd); with a TTL, the deadline timer and the bounded read at
    the deadline do, until the wait has settled. A `WaitJob` hold already sent
    when its wait settles cannot be withdrawn: the broker keeps that slot until
    the hold ends (at most 35 s), and the wait keeps its hold slot until then,
    but no further hold or read is issued. On the broker side, a `QueueManager`
    shut down while its TCP server still serves connections answers pending
    `WaitJob` holds with `completed: true` and no result
    (`EventsManager.clear()` resolves its completion waiters,
    `eventsManager.ts:61`, `handlers/advanced/jobs.ts:127-135`), and the wait
    trusts that reply, so it can resolve `undefined` for a job that did not
    complete; this server-side limitation is tracked separately.
  - A job without a runtime (`toPublicJob`/`createPublicJob` without a wait
    callback, or no embedded manager and no TCP connection) rejects with
    `waitUntilFinished: no connection`. Every path settles exactly once and
    removes its listeners, manager registration, scheduled reads, hold request
    and timers, including when an emitter reports the outcome synchronously
    while the wait is still subscribing (the wait then arms no timer and reads no
    state; `test/job-wait-sync-source.test.ts`).

  | Path | Mode | Outcome source | Already finished | Finishes during the wait | Job gone |
  | --- | --- | --- | --- | --- | --- |
  | QueueEvents | embedded | manager events (+ emitter) | first read, at once | event, at once | `removed`: at once; else next safety-net read |
  | none | embedded | manager events | first read, at once | event, at once | `removed`: at once; else next safety-net read |
  | QueueEvents | TCP | QueueEvents events | read after ready, one round trip | event, at once | `removed`: at once; else next safety-net read |
  | none | TCP | holds (40 per connection, FIFO) + scheduled reads | first read, one round trip | completion: at once with a hold slot, else next read or slot; failure: next read | next read |
  | QueueEvents closed | embedded | manager events (unchanged) | first read, at once | event, at once | as above |
  | QueueEvents closed | TCP | as "none" over TCP | next read | as "none" over TCP | next read |

  - Behavior changes from the per-path waiters this replaced: a retried attempt
    no longer settles the wait; a Job object over TCP listens to the QueueEvents
    it is given instead of ignoring it; an embedded `queue.add()` job accepts
    `null`; a TTL of `0` without QueueEvents no longer times out at once; a
    missing job rejects with `Job <id> not found` instead of a timeout (TCP) or
    a wait to the TTL (QueueEvents); a DLQ or other already-failed job rejects at
    once with its failure reason; an embedded wait at `shutdownManager()`
    rejects with the shutdown error instead of resolving `undefined`; a TCP wait
    is no longer cut short by `commandTimeout`, accepts TTLs above 600000 ms, and
    with more than 40 waits per connection no longer takes every broker slot of
    the connection, but a wait beyond the slots can see its job's completion
    seconds late (see Limitations; use `QueueEvents` for high-concurrency
    request/response); a refused state read rejects instead of being ignored; a
    detached job rejects instead of resolving `undefined`.
- **`QueueEvents` transport**: embedded mode subscribes to the shared manager;
  TCP mode uses a dedicated socket so unsolicited event frames cannot consume a
  pooled command response. The subscription authenticates before subscribing,
  re-subscribes after a broker reconnect, and stops delivery on `close()`. A
  transport or handler error is emitted only when an `error` listener exists,
  avoiding Node's unhandled `error` behavior. Progress payloads expose the
  public progress value rather than the manager's internal event envelope.
  `failed` payloads carry `terminal: event.terminal !== false`, so failures
  from brokers that predate the flag count as terminal. Besides its public
  events, a QueueEvents raises two internal signals for job waits
  (`queue-events/streamSignals.ts`, a `WeakMap` keyed by the instance, so
  `removeAllListeners()` cannot drop them and no public listener sees them):
  `resubscribed` after a TCP re-subscription and `closed` from `close()`.
- **`prefixKey` isolation invariant**: every context created by
  `queue/runtime/state.ts` forwards `queueKey = prefixKey + name`, so two queues
  with the same logical name but different prefixes never collide; a consuming
  Worker must use the same prefix.
- **Processor error classes**: throwing `UnrecoverableError` skips remaining retries (straight to failed/DLQ); `DelayedError` re-delays without counting as a failure (`errors.ts`), by the base backoff capped at a positive `backoff.maxDelay` (a `maxDelay` of 0 does not apply; the wait is never zero) (`calculateDelayedErrorDelay`, see `client-worker-sdk.md`).

## Configuration

Constructor `QueueOptions` (`client/types/connection.ts`): `embedded` (default
falls back to `BUNQUEUE_EMBEDDED=1`), `dataPath` (embedded; overrides env),
`defaultJobOptions`, `connection`, `autoBatch`, `prefixKey`. Connection settings
exist only inside `connection`; top-level `host`/`port`/`token`/`tls` throw in
TCP mode. The same guard runs in `FlowProducer`, `QueueEvents` (unless
`embedded: true`, because it otherwise falls back to embedded without
`connection`), `Bunqueue`, `SandboxedWorker` (unless an embedded `manager` is
injected), the workflow `Engine`, and `Worker` (via `resolveWorkerOptions`);
`QueueGroup.getQueue()/getWorker()` inherit it. `TcpConnectionPool` and
`Forwarder` (`to: { host, port }`) take connection settings directly and are
unaffected.

`ConnectionOptions` defaults applied in `queue/runtime/state.ts` are
`poolSize = 4` (`4` + no token ⇒ shared pool), `host = 'localhost'`, and
`port = 6789`. Timeout, ping, pipelining, and in-flight defaults are owned by
the transport — see [Client Transport](./client-transport.md).

`AutoBatchOptions`: `enabled` default true for TCP / disabled for embedded (must be a boolean), `maxSize = 50` (a positive integer), `maxDelayMs = 5` (a finite number of ms >= 0).

Embedded data path env precedence (via `getSharedManager`): `BUNQUEUE_DATA_PATH > BQ_DATA_PATH > DATA_PATH > SQLITE_PATH`. The environment is read only when a fresh manager is created; `shutdownManager()` resets both the manager and its path identity. `StallConfig` defaults (TCP cache + fallback): `enabled: true`, `stallInterval: 30000`, `maxStalls: 3`, `gracePeriod: 5000` (`stall.ts:16`).

## Related Docs

- [Client SDK: Worker (& sandboxed)](./client-worker-sdk.md)
- [Client Transport (TCP pool, reconnect, batching)](./client-transport.md)
- [Core Queue Engine (QueueManager & Shards)](./core-queue-engine.md)
- [Job Lifecycle (push / pull / ack / fail)](./job-lifecycle.md)
- [Job Queries & Queue Control](./job-queries-and-control.md)
- [Dead Letter Queue (DLQ)](./dead-letter-queue.md)
- [Deduplication & Unique Jobs](./deduplication-and-unique.md)
- [Scheduler & Cron](./scheduler-and-cron.md)
- [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md)
- [FlowProducer & Job Dependencies](./flow-producer.md)
- [Webhooks, Events & Job Logs](./webhooks-and-events.md)
- [Store-and-Forward & BullMQ Compatibility](./store-and-forward.md)
- [Simple Mode (Bunqueue all-in-one)](./simple-mode.md)
- [TCP Server Command Handlers](./tcp-server-handlers.md)
- [architecture](../architecture.md)
- [data-model](../data-model.md)
