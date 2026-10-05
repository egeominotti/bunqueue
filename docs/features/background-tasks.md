# Background Tasks

> **Category:** Scheduling · **Source:** `src/application/backgroundTasks.ts`, `src/application/background/`, `src/application/cleanupTasks.ts`, `src/application/orphanRecovery.ts`, `src/application/clientOwnership.ts`, `src/application/dependencyProcessor.ts`, `src/application/monitoringChecks.ts`, `src/application/taskErrorTracking.ts`

## Purpose

This module orchestrates all server-side maintenance work that keeps a
`QueueManager` healthy without a client request driving it. It owns a
next-deadline scheduler for processing timeouts plus the periodic `safeInterval` timers
for stall detection, expired-lock recovery, DLQ auto-retry/expiry, dependency
resolution, memory-bound garbage collection, and dashboard monitoring. It also
owns startup `recover()`, the one-shot pass that rebuilds in-memory shard state
from SQLite after a restart.

## Responsibilities & Scope

Owns:

- The stable export surface in `backgroundTasks.ts` and the interval lifecycle in `background/lifecycle.ts`.
- Job-timeout enforcement and explicit failure classification (`background/timeouts.ts`).
- DLQ maintenance dispatch in `background/dlq.ts`.
- Startup recovery, split by lifecycle state under `background/recovery/`.
- Recovery of orphaned processing entries (through the stall path, `orphanRecovery.ts`), memory-bound cleanup of stale waiting-deps, unique keys/groups, stalled candidates, orphaned `jobIndex`/`jobLocks`, client ownership of ended deliveries (`pruneEndedClientDeliveries`, `clientOwnership.ts`), and empty queues (`cleanupTasks.ts` plus the focused `emptyQueueCleanup.ts` reconciler).
- Dependency resolution as a safety fallback to the event-driven fast path (`processPendingDependencies`, `dependencyProcessor.ts:16`).
- Dashboard threshold monitoring and hysteresis state (`runMonitoringChecks`, `monitoringChecks.ts:56`).
- Circuit-breaker error tracking for the `cleanup`, `dependency`, and `lockExpiration` tasks (`taskErrorTracking.ts`).

Does NOT own (delegated):

- Stall classification/handling — delegated to `checkStalledJobs` in `stallDetection.ts` (see [Concurrency & Locking](./concurrency-and-locking.md)). Cleanup's orphan recovery reuses the same exported `handleStalledJob` transition.
- Expired-lock requeue/DLQ logic — delegated to `checkExpiredLocks` in `lockManager.ts`.
- The actual DLQ re-queue/purge mechanics — delegated to `processAutoRetry` / `purgeExpiredDlq` in `dlqManager.ts` (see [Dead Letter Queue](./dead-letter-queue.md)).
- Cron/delayed scheduling — owned by `CronScheduler` (started/stopped here but implemented in [Scheduler & Cron](./scheduler-and-cron.md)).
- S3 backup intervals — handled outside this module (see [S3 Backup](./backup-s3.md)).
- SQLite I/O — delegated to the storage layer (see [Persistence](./persistence.md)).

## Dependencies

Internal:

- [Core Queue Engine](./core-queue-engine.md) — operates on `ctx.shards`, `ctx.processingShards`, `ctx.jobIndex`, and the `BackgroundContext` built by `QueueManager`'s context factory.
- `stallDetection.ts` (`checkStalledJobs`) and `lockManager.ts` (`checkExpiredLocks`) — invoked directly from the interval bodies; `orphanRecovery.ts` (called from `cleanupTasks.ts`) calls `handleStalledJob` for orphans.
- `dlqManager.ts` (`processAutoRetry`, `purgeExpiredDlq`) — see [Dead Letter Queue](./dead-letter-queue.md).
- [Persistence](./persistence.md) — `ctx.storage` (`loadActiveJobs`, `loadPendingJobs`, `loadCompletedJobs`, `loadDlq`, `loadQueueState`, `saveDlqEntry`, `deleteJob`, `updateForRetry`) and `isCorruptDependsOn` from `sqliteSerializer`.
- [Scheduler & Cron](./scheduler-and-cron.md) — `CronScheduler.start()` / `.stop()`.
- [Data Structures](./data-structures.md) — `BoundedSet`/`BoundedMap`/`LRUMap` collections, priority-queue `compact()`/`needsCompaction()`, and the per-shard temporal index.
- `src/shared/hash` — `shardIndex`, `processingShardIndex`, `SHARD_COUNT`. `src/shared/lock` — `withWriteLock`.
- [Worker Registry & Management](./workers-management.md) — `ctx.workerManager.list()` for worker-overload monitoring.

External/runtime:

- Bun/Node timers through `safeInterval` (`src/shared/timers.ts`, see [Shared Timers & Durations](./shared-timers.md)): a period that fits is one native `setInterval`; a longer one is re-armed per period instead of being shortened to a 1 ms spin. Each handle is a `SafeTimer`, stopped with `clear()`.
- `process.memoryUsage()` for memory-pressure monitoring (`monitoringChecks.ts:166`).
- No third-party runtime dependencies.

## Public Interface

Exported from `backgroundTasks.ts`:

```typescript
export interface BackgroundTaskHandles {
  cleanupInterval: SafeTimer;
  timeoutScheduler: JobTimeoutScheduler;
  depCheckInterval: SafeTimer;
  stallCheckInterval: SafeTimer;
  dlqMaintenanceInterval: SafeTimer;
  lockCheckInterval: SafeTimer;
  cronScheduler: CronScheduler;
}

export function startBackgroundTasks(
  ctx: BackgroundContext,
  cronScheduler: CronScheduler
): BackgroundTaskHandles;

export function stopBackgroundTasks(handles: BackgroundTaskHandles): void;

export function checkJobTimeouts(ctx: BackgroundContext): Promise<void>;
export function recover(ctx: BackgroundContext): void;

// Re-exports
export { getTaskErrorStats }; // from taskErrorTracking
export { processPendingDependencies }; // from dependencyProcessor
```

Exported from `cleanupTasks.ts`:

```typescript
export async function cleanup(ctx: BackgroundContext): Promise<void>;
```

Exported from `orphanRecovery.ts` (called by `cleanup`):

```typescript
export const ORPHAN_WINDOW_FLOOR_MS = 30 * 60 * 1000;
export async function recoverOrphanedProcessingEntries(
  ctx: BackgroundContext,
  now: number
): Promise<void>;
```

Exported from `dependencyProcessor.ts`:

```typescript
export async function processPendingDependencies(ctx: BackgroundContext): Promise<void>;
```

Exported from `monitoringChecks.ts`:

```typescript
export interface MonitoringState {
  readonly thresholds: MonitoringThresholds; // read once, when the state is created
  queueIdleSince: Map<string, number>;
  queueThresholdEmitted: Set<string>;
  workerOverloadedSince: Map<string, number>;
  storageWarningEmitted: boolean;
  memoryWarningEmitted: boolean;
}
// Default: readMonitoringThresholds() (src/config/componentEnv.ts); throws on an invalid env var.
export function createMonitoringState(thresholds?: MonitoringThresholds): MonitoringState;
export function runMonitoringChecks(ctx: MonitoringContext): void;
```

Exported from `taskErrorTracking.ts`:

```typescript
export interface TaskErrorState {
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: number;
}
export function handleTaskError(taskName: string, err: unknown): void;
export function handleTaskSuccess(taskName: string): void;
export function getTaskErrorStats(): Record<string, TaskErrorState>;
```

No TCP commands, HTTP endpoints, or CLI commands are defined here. `getTaskErrorStats()` is surfaced via `QueueManager` for monitoring (see [Stats, Metrics & Monitoring](./stats-and-monitoring.md)). `getMemoryStats()` reflects the collections these tasks bound.

### Dashboard events emitted

Emitted via `ctx.dashboardEmit?.(event, data)` (consumed by [bunqueue Cloud Dashboard Integration](./cloud-integration.md)):

- `job:timeout` — `checkJobTimeouts` (`background/timeouts.ts`)
- `dlq:auto-retried`, `dlq:expired` — `performDlqMaintenance` (`background/dlq.ts`)
- `cleanup:completed-removed` — bounded automatic SQLite retention
  (`cleanupTasks.ts`)
- `cleanup:orphans-removed` — `recoverOrphanedProcessingEntries` (`orphanRecovery.ts`); `count` is the number of orphans this pass took out of processing through the stall path (each one also emits `job:stalled`). The name is kept for dashboard compatibility.
- `cleanup:stale-deps-removed` — `cleanStaleWaitingDependencies` (`cleanupTasks.ts`)
- `queue:removed` — `cleanEmptyQueues` (`emptyQueueCleanup.ts`)
- `job:dependencies-resolved` — `promoteJobsToQueue` (`dependencyProcessor.ts:105`)
- `queue:idle`, `queue:threshold`, `worker:overloaded`, `server:memory-warning`, `storage:size-warning` — `monitoringChecks.ts`

The stall and lock-expiry intervals (and cleanup's orphan recovery, through the stall path) additionally drive `job:stalled` /
`job:lock-expired` events plus `EventType.Stalled`/`EventType.Failed` broadcasts
and `stalled` webhooks from their respective sibling modules (see [Webhooks,
Events & Job Logs](./webhooks-and-events.md)). A terminal lock expiry broadcasts
`Stalled` before `Failed`; retryable lock expiry broadcasts only `Stalled`.

## Data Models

See [data-model](../data-model.md) for full definitions. The most relevant shapes:

- `BackgroundContext` extends `QueueManagerState` and adds the callbacks and
  collections the tasks need: `fail(jobId, error?, failureReason?)`,
  `registerQueueName`/`unregisterQueueName`, `dashboardEmit`, `workerManager`,
  `monitoringState`, `completedJobsData: BoundedMap<JobId, Job>`,
  `depCompletions?: DependencyCompletionTracker` (bounded recent bare IDs plus
  IDs pinned by live dependency edges),
  `timedOutJobs: BoundedMap<JobId, RetiredTimeoutGeneration>` (latest retired
  generation by ID), and `retiredTimeoutLeaseTokens` (exact retained lease
  history for late outcomes).
- `LockContext` (`src/application/types/contexts.ts`) — narrowed view passed to `checkExpiredLocks`, built by `getLockContext` in `background/lifecycle.ts`. It MUST carry `storage: ctx.storage`: this is the only production path to `checkExpiredLocks`, and without it the `saveDlqEntry`/`deleteJob` persistence inside `handleMaxStallsExceeded` silently no-ops through optional chaining (issue #110 — the #97 fix never executed on this path from 2.8.17 to 2.8.27, leaving orphan `active` rows in SQLite and memory-only DLQ entries).
- `DEFAULT_CONFIG` (`src/application/types/config.ts`) — the interval defaults (see [Configuration](#configuration)).
- `Job` — fields read/written by these tasks: `timeout`, `startedAt`, `lastHeartbeat`, `stallCount`, `attempts`, `runAt`, `dependsOn`, `uniqueKey`, `customId`, `deduplicationTtl`, `timeline`.
- `TaskErrorState` / `MonitoringState` — module-local tracking shapes shown above.

## Business Logic / Control Flow

### Startup: `recover(ctx)` (`background/recovery/index.ts`)

Runs once before the intervals start (called from the `QueueManagerState`
constructor in `queue-manager/state.ts`). No-op if `ctx.storage` is null
(in-memory mode). It loads payload-free dependency proofs, DLQ IDs, queue/group
state, and cold completed queue names up front, then emits structured start,
phase-progress, and completion diagnostics at debug level on stderr:

1. **Phase 1 — active jobs** (`background/recovery/active.ts`): before scanning, recovery restores each
   persisted custom `StallConfig` and `DlqConfig` from `queue_state`, because
   their bounds, retry scheduling, and retention fields are needed to classify
   interrupted work. It then repeatedly loads the first
   `RECOVERY_BATCH_SIZE = 10000` rows. Every handled row leaves the active result
   set, so incrementing `OFFSET` over the shrinking set would skip rows.
2. **Phase 2 — pending jobs** (`background/recovery/pending.ts`): paginated by deterministic `priority DESC, run_at ASC, id ASC`. Each page collects only its referenced dependency IDs and asks SQLite which of those IDs are retained completions; it never materializes the full completed table. This phase is the single authoritative enqueue path for both original pending jobs and retries persisted by Phase 1, preventing duplicate heap entries/counter increments. Corrupt-deps are quarantined; unsatisfied dependencies enter `waitingDeps`; dedup mappings are restored.
3. **DLQ restore** (`background/recovery/restore.ts`): `loadDlq()` restores every persisted entry into memory exactly once (this is why `quarantineCorruptDependsOn` deliberately does NOT touch in-memory DLQ — it only persists + drops the job row).
4. **Queue control-state restore** (`background/recovery/restore.ts`, issue
   #100): the `loadQueueState()` snapshot used before Phase 1 for stall/DLQ
   policy is reused to apply `paused`, rate-limit capacity/window/remaining TTL,
   and `concurrencyLimit` directly to the owning shard. Already-expired temporary
   rate limits are skipped; live ones resume with their remaining lifetime. If
   expiry/default normalization leaves no effective policy, recovery deletes
   the stale `queue_state` row instead of registering an empty queue forever.
5. **Phase 3 — completed hot cache** (`background/recovery/restore.ts`): loads up to `maxCompletedJobs` rows into `completedJobs`/`completedJobsData` for low-latency lookups. SQLite cleanup and completed statistics remain database-authoritative beyond this window. `customIdMap` is intentionally NOT populated here to avoid LRU-evicting pending-job mappings.

If any recovery phase, flow-outbox replay, or cron restore throws, constructor
unwinding closes the SQLite write-buffer timer and stops the partially-created
cron, worker, event, and telemetry services before rethrowing. The process can
therefore fail fast before listener bind even when the database is corrupt.

### `startBackgroundTasks` (`background/lifecycle.ts`)

Registers five maintenance intervals (`safeInterval`), starts the timeout
deadline scheduler, and calls `cronScheduler.start()`:

| Interval handle          | Config key                              | Default        | Body                                                                                                                   |
| ------------------------ | --------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cleanupInterval`        | `cleanupIntervalMs`                     | 10s            | Optional bounded completed retention, memory cleanup, then monitoring; success/error tracking wraps the full pass      |
| `timeoutScheduler`       | each active job's `startedAt + timeout` | exact deadline | One bounded timer tracks the earliest registered deadline                                                              |
| `depCheckInterval`       | `dependencyCheckMs`                     | 30s            | early-return if `pendingDepChecks.size === 0`, else `processPendingDependencies(ctx)` with `dependency` error tracking |
| `stallCheckInterval`     | `stallCheckMs`                          | 5s             | `checkStalledJobs(ctx)`                                                                                                |
| `dlqMaintenanceInterval` | `dlqMaintenanceMs`                      | 60s            | `performDlqMaintenance(ctx)`                                                                                           |
| `lockCheckInterval`      | `stallCheckMs`                          | 5s             | `checkExpiredLocks(getLockContext(ctx))` with `lockExpiration` error tracking                                          |

Note: monitoring runs on the cleanup tick (10s), not its own timer — it is invoked inside the `cleanup().then()` callback in `background/lifecycle.ts`. The dependency interval is a **safety fallback only**; the fast path is event-driven in `QueueManager` (the 30s default and the `pendingDepChecks.size` guard reflect this — it is not a 100ms hot loop).

### `JobTimeoutScheduler` (`background/timeouts.ts`)

Active jobs with a processing timeout are registered in a min-heap keyed by
`processingDeadline(job)` = `Math.ceil(startedAt + timeout)`: a fractional timeout is
rounded up to the next whole millisecond (honoured, never early), a `0`/`NaN`/unset
timeout means no timeout, and a deadline that is still not a safe integer (an
infinite or absurdly large timeout) is `NEVER_DEADLINE` (`Number.MAX_SAFE_INTEGER`)
(`test/repro-job-timeout-fractional.test.ts`). The rule lives in
`src/domain/job/timeoutRule.ts`, shared with the Worker: the Worker aborts its
processor after `processingTimeoutDelay(job)`, the distance from `startedAt` to the
same deadline (none for `NEVER_DEADLINE`), then leaves the job to this scheduler, so
the two can never disagree about which deadlines exist
(`test/worker-job-timeout-rule.test.ts`, [Client SDK: Worker](./client-worker-sdk.md)).
One `setTimeout` is armed for the
earliest live entry; earlier arrivals re-arm it, and every processing exit cancels
or re-synchronizes the job's generation. Delays above the runtime's signed 32-bit
timer ceiling are chunked at `2_147_483_647` ms (`timeoutTimerDelay` = at least
1 ms, then `clampTimerDelay` from [Shared Timers](./shared-timers.md)) without
changing the absolute deadline: a chunk that fires with nothing due re-arms for
what remains.
`timeoutTimerDelay` maps a NaN distance to 1 ms instead of throwing out of
`schedule()` on the pull path (only a NaN `jobTimeoutCheckMs` retry could make one).
Cancelled generations are rejected by entry identity and `startedAt`, so a
recycled custom ID cannot inherit an old timeout.

When a deadline expires, the scheduler invokes the internal failure transition
with `FailureReason.Timeout`. Its synchronous `onClaim` callback records the
exact `{ jobId, startedAt, token? }` generation while the processing write lock
is held, before that exact job is removed; the dashboard event is emitted only
after the transition settles. ACK and FAIL reclassify after their own claim,
so either completion/failure wins first or the exact late outcome is ignored —
there is no validation-to-claim gap.
`checkJobTimeouts(ctx)` remains as an explicit compatibility/audit entry point;
ordinary enforcement does not scan every processing shard on a fixed cadence.

### `performDlqMaintenance` (`background/dlq.ts`)

For each queue in `queueNamesCache`, calls `processAutoRetry` (re-queues entries whose retry schedule is due, when `autoRetry` is enabled) and `purgeExpiredDlq` (drops entries past `maxAge`), emitting `dlq:auto-retried`/`dlq:expired` with the counts. Per-queue `try/catch` logs `DLQ maintenance failed` and continues — one bad queue cannot stall the rest.

### `cleanup` (`cleanupTasks.ts`)

Runs in order each tick: refresh delayed counters per shard; compact any priority queue with `needsCompaction(0.2)` (>20% tombstones); then `recoverOrphanedProcessingEntries`, `cleanStaleWaitingDependencies`, `cleanUniqueKeysAndGroups`, `cleanStalledCandidates`, `cleanOrphanedJobIndex`, `cleanOrphanedJobLocks`, `pruneEndedClientDeliveries`, `cleanEmptyQueues`.

`recoverOrphanedProcessingEntries` (`orphanRecovery.ts`) is a backstop for the
stall checker and does not recover anything the stall checker would keep. One
difference: like lock expiration and startup recovery it treats `maxStalls: 0`
as unlimited, while the stall checker moves a job to the DLQ on its first stall
(`src/domain/types/stall.ts`). It recovers an
active job only when all of these hold (`isOrphanedProcessingEntry`):

- `startedAt` is set (an entry without it is never an orphan here);
- the queue's stall detection is enabled (`shard.getStallConfig(queue).enabled`).
  A queue with `enabled: false` is skipped entirely: disabling stall detection
  opts the queue out of every heartbeat-based recovery, this one included;
- the job is past the queue's `gracePeriod` (`now - startedAt >= gracePeriod`),
  as `checkStall` requires;
- `now - max(startedAt, lastHeartbeat) > window`, where
  `window = max(30 min, job.stallTimeout ?? stallInterval)`
  (`ORPHAN_WINDOW_FLOOR_MS`). A job or queue that allows itself a longer stall
  window postpones recovery to that window; a shorter one keeps the 30-minute
  floor. Because `max(startedAt, lastHeartbeat) >= lastHeartbeat` and the
  window is at least the stall window, every orphan is also stalled by the
  stall checker's own rule. `lastHeartbeat` is refreshed at
  pull, by token-less `jobHeartbeat`, by progress updates and by every successful
  lock renewal (`renewJobLock`, the default worker path with `useLocks: true`), so
  a job that keeps heartbeating or renewing is never aged out however long it runs;
- the job holds **no unexpired lock of its current processing generation** in
  `jobLocks`. A valid lease is ownership granted to a worker (for example a long
  `lockDuration` without renewals); the lock-expiration sweep, not cleanup,
  decides when it lapses. An expired lease does not count as liveness, and
  neither does a lease from an earlier generation: stall retry keeps the
  previous lease in place as a stale-outcome guard, so the sweep applies the
  same rule as `createLock` (`isLeaseFromEarlierGeneration`, `domain/job/locks.ts`):
  the lease is stale when `job.startedAt > lock.createdAt`. Pull stamps
  `startedAt` from a clock read taken before `createLock` runs in the same
  delivery, so a lease from the current pull always has `createdAt >= startedAt`;
  the comparison is strict, so a lease created in the same millisecond as the
  pull still protects the job.

An orphan is a stalled job the stall checker did not reclaim (for example its
recovery attempt failed on a lock timeout), so it takes the stall recovery
path: phase 1 collects candidates lock-free, phase 2 calls
`handleStalledJob(job, action, ctx, recheck)` per orphan. That call takes
`shardLocks[shardIndex(queue)]` then `processingLocks[procIdx]` (hierarchy
order; the sweep holds no lock of its own), confirms the same job object is
still in processing, and only then runs the whole predicate again with a fresh
clock and the current stall configuration, because a heartbeat, progress
update, renewal or `setStallConfig` can land while the sweep waits for either
lock. If the job is still an orphan it is recovered exactly like a stall:
concurrency/group/unique-key resources are released (`releaseJobResources`),
the owning client connection is detached (`detachClientJob`), the timeout entry
is cancelled, `attempts` and
`stallCount` are incremented, and the job is retried with backoff and persisted
with `updateForRetry`, or moved to the DLQ (`saveDlqEntry` + `deleteJob`) when
`attempts` runs out or the stall budget is spent. The stall budget follows lock
expiry and startup recovery: a positive `maxStalls` sends the orphan to the DLQ
once `stallCount + 1 >= maxStalls`; `0` is unlimited. Cron `preventOverlap`
jobs are discarded for the scheduler to recreate. `job:stalled` and the
`Stalled` queue event are emitted after the transition, and one
`cleanup:orphans-removed { count }` summarizes the pass. A recovery error is
logged per job and the sweep continues; an entry left in processing is
reconsidered on the next tick.

Before this rule the sweep aged entries by `startedAt` alone and removed
heartbeating long-running jobs (`test/repro-cleanup-heartbeating-active-job.test.ts`).
After that fix it still only deleted a true orphan from `processingShards`,
`jobIndex` and the timeout scheduler: the concurrency slot, group slot and
unique key stayed held, SQLite kept the row `active`, no attempt was counted and
no event fired until a restart resurrected the job
(`test/repro-cleanup-orphan-recovery.test.ts`,
`test/cleanup-orphan-recovery-guards.test.ts`). The fixed 30-minute window
then overrode the stall configuration: a job with a longer `stallTimeout`, a
queue with a longer `stallInterval`, or a queue with stall detection disabled
was recovered after 30 minutes and could run twice
(`test/repro-orphan-window-respects-stall-config.test.ts`,
`test/orphan-window-boundaries.test.ts`).

`pruneEndedClientDeliveries` runs synchronously after the lock sweep and drops
every client ownership record whose delivery has ended (its `jobIndex` entry is
no longer the processing entry the connection registered). Recovery paths
detach ownership themselves; the prune bounds `clientJobs`/`clientJobOwners`
when an ACK or FAIL arrives on a different pooled connection than the pull,
which unregisters the sender rather than the owner. See
[Webhooks, Events & Job Logs](./webhooks-and-events.md) for the ownership rule.

A dependency-gated job older than one hour is removed under its shard write lock after a TOCTOU age re-check. Its SQLite row or pending buffered insert is deleted first, then the reverse dependency index, `jobIndex`, owned unique/custom ID reservations, and dependency-result consumer edges are released together.

`cleanEmptyQueues` snapshots registered names, reads exact SQLite completion
counts with 500-name primary-key batches, and precomputes occupied/configured
queue sets once. It preserves queued, processing, DLQ, waiting-dependency,
`waiting-children`, completed-only, policy-only, and asynchronously admitting
queues. Admission ownership is a per-queue reference count, so one completed
concurrent push cannot expose another push that is still waiting for a lock.
Policy discovery applies temporary rate-limit expiry and retains only
non-default DLQ/stall configuration. A completed-only or policy-only name stays
registered, but its empty priority heap and secondary group runtime are still
reclaimed. Every fully unowned name is unregistered and its durable queue/group
state rows are deleted before the remaining runtime is reclaimed. A storage
failure therefore aborts that removal with the queue still registered. Events
are emitted only after reconciliation, so a synchronous listener that recreates
this or another queue cannot be erased by the remainder of the old cleanup.

### `processPendingDependencies` (`dependencyProcessor.ts:16`)

Drains `pendingDepChecks` into a local array (clearing the set), uses each
shard's reverse index (`getJobsWaitingFor`) to find waiting jobs — O(m) in
waiters, not O(n) in all jobs — then per shard, under the shard write lock,
re-checks every dependent's `dependsOn` against the current completion batch,
`completedJobs`, or `depCompletions`. A ready parent is checkpointed in SQLite
before its reverse edges are removed and it becomes visible in the run queue.
After all shard locks are released, dependency proofs with no remaining waiter
are unpinned and ordinary FIFO pruning resumes. See
[FlowProducer & Job Dependencies](./flow-producer.md).

### `runMonitoringChecks` (`monitoringChecks.ts:56`)

Returns immediately if `dashboardEmit` is unset. Otherwise runs `checkQueueIdle`, `checkQueueThreshold`, `checkWorkerOverload`, `checkMemoryPressure`, `checkStorageSize`. Idle/overload use a "since" timestamp so the event only fires once the threshold duration has elapsed; threshold/memory/storage use one-shot "emitted" flags with hysteresis (re-armed below 90% of the threshold).

## Concurrency & Locking

The lock hierarchy is `jobIndex → completedJobs → shards[N] → processingShards[N]` (see [Concurrency & Locking](./concurrency-and-locking.md)). Within this module:

- `recoverOrphanedProcessingEntries`, `cleanStaleWaitingDependencies`, and `cleanOrphanedJobIndex` use a **two-phase** pattern: collect candidates lock-free, then mutate under the owning write lock and re-check membership/age inside the lock. For processing entries the second phase is `handleStalledJob`, which holds `shardLocks` then `processingLocks` and re-checks job identity plus the full orphan predicate (stall configuration, grace period, silence window and an unexpired lease of the current generation) before the transition.
- `processPendingDependencies` acquires `shardLocks[i]` **before** reading `waitingDeps`, then runs shards in parallel via `Promise.all`.
- The stall and lock-expiry delegates (`stallDetection.ts`, `lockManager.ts`) acquire `shardLocks` **before** `processingLocks` (hierarchy order). The stall checker re-evaluates its confirmed stall under both locks (`StallRecheck`), so a heartbeat or a new delivery of the same job object that lands while it waits keeps the job. The lock-expiry sweep revalidates the collected job identity, current lease identity, expiry and lease generation (`isLeaseFromEarlierGeneration`) under both locks before consuming either recovery budget; overlapping sweeps, renewal, ACK, and a newer delivery generation therefore cannot reclaim the same lease twice, and an earlier delivery's lease never reclaims a later lockless delivery. Overlapping stall, orphan and lock-expiry recoveries of one delivery transition it at most once (`test/recovery-sweeps-overlap.test.ts`). Events are broadcast only after the winning transition.
- Timeout entries are registered only after processing ownership (and any lease)
  is established. ACK/FAIL, manual moves, disconnect recovery, stall/lock
  recovery, cleanup, obliterate, and shutdown invalidate the matching entry.
  The expiry transition revalidates `jobIndex`, the processing map, `startedAt`,
  and entry identity before failing a job.
- `cleanUniqueKeysAndGroups`, `cleanStalledCandidates`, and `cleanOrphanedJobLocks` run without locks. `cleanEmptyQueues` is also lock-free, but its database read, set construction, and removals form one synchronous no-`await` turn. Processing `JobLocation` entries carry `queueName`, so an ACK between processing-map removal and completed publication still protects the owning queue. Push, batch, and flow entry points increment all unique target-queue admission counts before the first registration callback or `await`, then decrement them in `finally`; cleanup therefore sees every lock waiter and callback-reentrant admission. Stale dependency removal does take the shard write lock because it updates ownership, persistence, and reverse indexes as one lifecycle.
- `recover` runs in the constructor before any concurrent traffic, so it is lock-free by construction.

Stall detection uses two-phase confirmation (a job must be flagged in two consecutive 5s cycles via `stalledCandidates`) so a brief GC pause does not trigger a false stall. Lock expiry, stall detection and cleanup's orphan recovery (which reuses the stall transition) all reset `startedAt`, bump `attempts`/`stallCount`, and call `releaseJobResources` to free the concurrency slot + group + unique key before re-pushing or moving to DLQ. Both reclaim paths enforce `attempts < maxAttempts` and `stallCount < maxStalls` before requeueing; `updateForRetry` persists both counters so a restart cannot replenish either budget.

## Edge Cases & Failure Modes

- **Circuit breaker (log-only):** `taskErrorTracking` counts consecutive failures per task (`cleanup`, `dependency`, `lockExpiration`). At `MAX_CONSECUTIVE_FAILURES = 5` it logs `CRITICAL: Background <task> repeatedly failing`. It does **not** stop the interval — the timer keeps firing and `handleTaskSuccess` resets the counter on the next clean run. Timeout transition failures are logged per job and retried after `jobTimeoutCheckMs`; stalls and DLQ maintenance retain their own error handling.
- **Timeout / late-outcome race:** exact generation evidence is recorded inside
  the failure claim. Late ACK, FAIL, manual failure, and sandbox outcomes are
  ignored only for that retired generation; a current retry token remains
  authoritative and arbitrary tokens still fail.
- **Corrupt `depends_on`:** quarantined to DLQ on recovery so a job with unrecoverable dependency metadata is never enqueued as ready (out-of-order execution) nor parked in `waitingDeps` forever (unbounded leak).
- **Stale `active`/DLQ rows from legacy DBs:** Phase 1 drops orphan rows for jobs already present in the DLQ table so they are not double-counted (predates the `failJob` DLQ-row cleanup fix; issue #97 lineage).
- **Cron `preventOverlap` jobs:** never re-queued by recovery, stall, or lock-expiry paths — they are deleted and left to the scheduler to recreate (issues #73/#75).
- **Memory and disk bounds:** cleanup compacts priority queues at >20% tombstones; trims `uniqueKeys`/`activeGroups` by half when a queue exceeds 1000 entries; only walks `jobIndex` when `size > 100_000` (the full scan is expensive); evicts via `BoundedSet`/`LRUMap` caps elsewhere. When `completedRetentionMs` is configured, it also deletes at most 1,000 oldest eligible SQLite completions per tick. Hot-cache eviction alone never deletes durable rows.
- **`perQueueMetrics` not pruned on empty-queue removal:** intentional — counters are cumulative and must survive a transient drain; growth is bounded by the LRU cap and explicit queue obliteration reclaims it.
- **Completion-proof pinning:** recent `depCompletions` self-bound to
  `maxCompletedJobs`, but proofs referenced by waiting parents are excluded
  from pruning. Promotion, cancel, stale cleanup, failure-policy detach,
  explicit unlink, and parent-queue obliteration release pins only after the
  owning reverse edge and durable parent state have moved together.
- **Stale dependency persistence ordering:** the SQLite/write-buffer delete runs before in-memory removal. If storage throws, the lifecycle remains live in memory and can be retried on the next cleanup tick instead of leaving disk as the only surviving copy.
- **`recover` partial state:** if `ctx.storage` is null the whole pass is skipped. Active recovery drains offset zero because its dataset mutates; pending/completed scans use deterministic pages. Phase 3 is hard-capped at `maxCompletedJobs`, while dependency-state probes are bounded to IDs referenced by the current pending page.

## Configuration

Interval timings come from `DEFAULT_CONFIG` (`src/application/types/config.ts`), overridable via the `QueueManagerConfig` passed to `QueueManager`.
`resolveQueueManagerConfig` validates the five periods when the QueueManager is
constructed: each must be a finite number of milliseconds >= 1 (`undefined` keeps
the default). NaN, `0`, negatives, `Infinity`, `null` and non-numbers throw a
`RangeError`/`TypeError` naming the option, for example
`QueueManager: stallCheckMs must be a finite number of milliseconds >= 1 (got NaN)`.
Before, they reached `setInterval` raw and ticked about every millisecond (an
explicit `undefined` did too), and a NaN `jobTimeoutCheckMs` reached the timeout
scheduler's retry deadline. A period above 2^31 - 1 ms is honoured
(`test/repro-server-runtime-config.test.ts`):

| Option                 | Default  | Effect                                                                                                                                                                  |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanupIntervalMs`    | `10_000` | Cleanup + monitoring tick                                                                                                                                               |
| `jobTimeoutCheckMs`    | `5_000`  | Retry delay after a deadline transition fails; normal timeout precision comes from the job deadline                                                                     |
| `dependencyCheckMs`    | `30_000` | Dependency-resolution **safety fallback** (fast path is event-driven)                                                                                                   |
| `stallCheckMs`         | `5_000`  | Stall detection **and** lock-expiry checks (shared)                                                                                                                     |
| `dlqMaintenanceMs`     | `60_000` | DLQ auto-retry + expiry                                                                                                                                                 |
| `maxCompletedJobs`     | `50_000` | Hot completed cache and Phase 3 recovery cap; not disk retention                                                                                                        |
| `completedRetentionMs` | `null`   | Optional completed-row age; finite non-negative values are floored to milliseconds, invalid values disable retention, and each tick deletes at most 1,000 eligible rows |

Monitoring thresholds are read from env vars when a `QueueManager` creates its
`MonitoringState` (`createMonitoringState` → `readMonitoringThresholds`), not at
module load. Each must be a whole number >= 0 and `0` disables that check;
anything else (`abc`, `-1`, `1e12`) throws an error naming the variable, and a
server reports it at startup from `resolveServerConfig`:

| Env var                        | Default        | Effect                                                                      |
| ------------------------------ | -------------- | --------------------------------------------------------------------------- |
| `QUEUE_IDLE_THRESHOLD_MS`      | `30000`        | Emit `queue:idle` after this idle duration (`0` disables)                   |
| `QUEUE_SIZE_THRESHOLD`         | `0` (disabled) | Emit `queue:threshold` when waiting count reaches it                        |
| `WORKER_OVERLOAD_THRESHOLD_MS` | `30000`        | Emit `worker:overloaded` after sustained at-capacity duration               |
| `MEMORY_WARNING_MB`            | `0` (disabled) | Emit `server:memory-warning` when heap reaches it (re-arms below 90%)       |
| `STORAGE_WARNING_MB`           | `0` (disabled) | Emit `storage:size-warning` when SQLite size reaches it (re-arms below 90%) |

DLQ behavior (`autoRetry`, `maxAge`) is configured per queue via `setDlqConfig`; see [Dead Letter Queue](./dead-letter-queue.md). Stall behavior (`enabled`, `maxStalls`, `stallInterval`, `gracePeriod`) is per queue via `setStallConfig`; cleanup's orphan recovery reads the same configuration (skips disabled queues, waits `max(30 min, stallTimeout ?? stallInterval)` and the grace period). General env vars live in [Configuration & Entrypoint](./configuration.md).

## Related Docs

- [architecture](../architecture.md) — overall request/background-task flow.
- [data-model](../data-model.md) — `Job`, `BackgroundContext`, `LockContext`, DLQ entry shapes.
- [Core Queue Engine](./core-queue-engine.md) — shards, `processingShards`, `jobIndex`.
- [Concurrency & Locking](./concurrency-and-locking.md) — lock hierarchy and two-phase patterns.
- [Dead Letter Queue](./dead-letter-queue.md) — auto-retry/expiry mechanics.
- [Scheduler & Cron](./scheduler-and-cron.md) — `CronScheduler` lifecycle.
- [FlowProducer & Job Dependencies](./flow-producer.md) — dependency graph that `processPendingDependencies` resolves.
- [Persistence](./persistence.md) — recovery queries and corrupt-blob detection.
- [Deduplication & Unique Jobs](./deduplication-and-unique.md) — unique-key restoration on recovery.
- [Stats, Metrics & Monitoring](./stats-and-monitoring.md) — `getTaskErrorStats`, memory stats.
- [bunqueue Cloud Dashboard Integration](./cloud-integration.md) — consumer of the dashboard events.
- [Webhooks, Events & Job Logs](./webhooks-and-events.md) — `stalled`/`failed` event propagation.
