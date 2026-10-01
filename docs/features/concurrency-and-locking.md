# Concurrency & Locking

> **Category:** Engine · **Source:** `src/shared/lock.ts`, `src/shared/asyncLock.ts`, `src/shared/rwLock.ts`, `src/shared/lockTimeout.ts`, `src/shared/semaphore.ts`, `src/application/lockManager.ts`, `src/application/lockOperations.ts`, `src/application/stallDetection.ts`, `src/application/orphanRecovery.ts`, `src/domain/types/stall.ts`

## Purpose

This module provides the in-process synchronization primitives and the job-ownership machinery that keep bunqueue's sharded state consistent under concurrent access. It exposes two low-level primitives — an `RWLock` (used per-shard) and a `Semaphore` (used to bound per-connection command pipelining) — plus BullMQ-style job leasing (`JobLock` token + TTL) and stall detection (heartbeat timeout → retry/DLQ). It exists because the QueueManager mutates sharded in-memory structures (`shards[]`, `processingShards[]`) from many concurrent TCP commands and background timers, and because a worker that crashes mid-job must have its lease reclaimed without losing or double-running the job.

## Responsibilities & Scope

Owns:

- **Locking primitives** — `AsyncLock` (FIFO mutex) in `src/shared/asyncLock.ts`, `RWLock` (multi-reader/single-writer, writer-priority) in `src/shared/rwLock.ts`, and the stable `withLock`/`withReadLock`/`withWriteLock` façade in `src/shared/lock.ts`.
- **Concurrency limiter** — `Semaphore` + `withSemaphore` (`src/shared/semaphore.ts`).
- **Job leasing** — create/verify/renew/release of per-job `JobLock` tokens (`src/application/lockOperations.ts`).
- **Lock-expiration sweep** — `checkExpiredLocks`: reclaims jobs whose lease TTL elapsed, requeuing or moving to DLQ (`src/application/lockManager.ts`).
- **Stall detection** — two-phase heartbeat-timeout detection and recovery (`src/application/stallDetection.ts`, `src/domain/types/stall.ts`).

Does NOT own:

- The shard data structures, the lock _hierarchy_ discipline at call sites, or `releaseJobResources` (concurrency-slot / group / unique-key release) — see [Core Queue Engine](./core-queue-engine.md) and [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md).
- The actual `pull`/`ack`/`fail` state transitions that _call_ these lock APIs — see [Job Lifecycle](./job-lifecycle.md).
- Client-side `useLocks` / `heartbeatInterval` worker behavior — see [Client SDK: Worker](./client-worker-sdk.md).
- Background-task scheduling (the timers that drive `checkExpiredLocks`/`checkStalledJobs`) — see [Background Tasks](./background-tasks.md).

## Dependencies

Internal:

- `src/domain/types/job.ts` — `JobLock`, `createJobLock`, `isLockExpired`, `renewLock`, `DEFAULT_LOCK_TTL`, `LockToken`, `calculateBackoff`.
- `src/domain/types/stall.ts` — `StallConfig`, `StallAction`, `getStallAction`, `incrementStallCount`.
- `src/domain/types/dlq.ts` — `FailureReason`.
- `src/shared/hash.ts` — `shardIndex`, `processingShardIndex`, `SHARD_COUNT` (route a job to its shard / processing shard).
- `src/application/types/contexts.ts` — `LockContext`, `BackgroundContext` (the state bags these functions operate on).
- `src/shared/logger.ts` — `queueLog`.

External / runtime:

- Bun only: `Bun.env.LOCK_TIMEOUT_MS` (`lockTimeout.ts`), `Bun.randomUUIDv7()` for lease tokens (job.ts). No external libraries; timers via `setTimeout`/`setInterval`. SQLite is touched indirectly via `ctx.storage` for DLQ/delete persistence inside recovery paths.

## Public Interface

### `src/shared/lock.ts`

```typescript
export interface LockGuard {
  release(): void;
}
export class LockTimeoutError extends Error {}

export class AsyncLock {
  acquire(timeoutMs?: number): Promise<LockGuard>; // FIFO mutex, default LOCK_TIMEOUT_MS
  isLocked(): boolean;
  getQueueLength(): number;
}

export class RWLock {
  acquireRead(timeoutMs?: number): Promise<LockGuard>;
  acquireWrite(timeoutMs?: number): Promise<LockGuard>; // sync fast path when uncontested
  getState(): { readers: number; writer: boolean; writerWaiting: number };
}

export function withLock<T>(
  lock: AsyncLock,
  fn: () => T | Promise<T>,
  timeoutMs?: number
): Promise<T>;
export function withReadLock<T>(lock: RWLock, fn, timeoutMs?): Promise<T>;
export function withWriteLock<T>(lock: RWLock, fn, timeoutMs?): Promise<T>;
```

> Note: `RWLock` is the primitive actually used for per-shard locks (`shardLocks[]`, `processingLocks[]` are `RWLock[]`, instantiated by `queue-manager/state.ts`). `AsyncLock`/`withLock` are exported but not used by the shard machinery.

### `src/shared/semaphore.ts`

```typescript
export class Semaphore {
  constructor(maxPermits: number);
  acquire(): Promise<void>;
  tryAcquire(): boolean;
  release(): void;
  available(): number;
  waiting(): number;
}
export function withSemaphore<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T>;
```

### `src/application/lockOperations.ts`

```typescript
export function createLock(
  jobId: JobId,
  owner: string,
  ctx: LockContext,
  ttl?: number
): LockToken | null;
export function verifyLock(jobId: JobId, token: string, ctx: LockContext): boolean;
export function renewJobLock(
  jobId: JobId,
  token: string,
  ctx: LockContext,
  newTtl?: number
): boolean;
export function renewJobLockBatch(
  items: Array<{ id: JobId; token: string; ttl?: number }>,
  ctx: LockContext
): string[];
export function releaseLock(jobId: JobId, ctx: LockContext, token?: string): boolean;
export function getLockInfo(jobId: JobId, ctx: LockContext): JobLock | null;
```

### `src/application/lockManager.ts`

```typescript
export async function checkExpiredLocks(ctx: LockContext): Promise<void>;
// + re-exports of the lockOperations.ts functions and clientTracking.ts helpers
```

### `src/application/stallDetection.ts`

```typescript
export function checkStalledJobs(ctx: BackgroundContext): void;
```

### TCP commands that reach this module

Lease renewal / heartbeat flow through the TCP handlers (`src/infrastructure/server/handlers/monitoring.ts`) into `QueueManager`:

- `JobHeartbeat` / `JobHeartbeatBatch` → `renewJobLock` when a `token` is present, else updates `job.lastHeartbeat` (`queue-manager/locks.ts`).
- `ExtendLock` / `ExtendLocks` → `extendLock` → `renewJobLock`.
- `Heartbeat` → worker-level liveness (worker registry, not job leases).

Leases are created implicitly by `PULL`/`PULLB` via `pullWithLock`/`pullBatchWithLock` (`queue-manager/delivery.ts`) and released by `ACK`/`FAIL` (`queue-manager/ack.ts`). See [TCP Server Command Handlers](./tcp-server-handlers.md).

### Events emitted

Via `ctx.eventsManager.broadcast` and `ctx.dashboardEmit`:

- `Stalled` (`EventType.Stalled`) — on every recovered lock expiry, including the
  terminal DLQ path, and on stall retry/DLQ. A terminal lock expiry emits this
  event first so embedded and TCP Workers observe the lease loss consistently.
- `Failed` (`EventType.Failed`) — immediately after `Stalled` when lock expiry
  exhausts `maxStalls` or `maxAttempts` and moves the job to the DLQ.
- Dashboard events: `job:lock-expired` (lockManager.ts:178), `job:stalled` (stallDetection.ts:138).
- Webhook: `stalled` (stallDetection.ts:151).

## Data Models

Full type definitions live in the source files cited below. Most relevant here:

**`JobLock`** (`src/domain/types/jobs/model.ts:139-148`):

```typescript
interface JobLock {
  readonly jobId: JobId;
  readonly token: LockToken; // Bun.randomUUIDv7()
  readonly owner: string; // worker/client id
  readonly createdAt: number; // load-bearing for the #101 re-lease guard
  expiresAt: number;
  lastRenewalAt: number;
  renewalCount: number;
  readonly ttl: number; // DEFAULT_LOCK_TTL = 30_000 ms
}
```

`isLockExpired` is **inclusive**: `now >= lock.expiresAt` (`src/domain/job/locks.ts:23-25`). `renewLock` sets `expiresAt = now + ttl`, bumps `lastRenewalAt` and `renewalCount` (`src/domain/job/locks.ts:27-32`).

**`StallConfig`** (`src/domain/types/stall.ts:9`, defaults at stall.ts:21):

```typescript
interface StallConfig {
  enabled: boolean; // default true
  stallInterval: number; // default 30_000 ms (no-heartbeat timeout)
  maxStalls: number; // default 3 (then → DLQ)
  gracePeriod: number; // default 5_000 ms after start before checking
}
```

**`StallAction`** (stall.ts:92): `Retry` | `MoveToDlq` | `Keep`.

Lease state lives in `ctx.jobLocks: Map<JobId, JobLock>` and stall candidates live in `ctx.stalledCandidates: Set<JobId>` (`application/types/contexts.ts`, with storage and collection ownership in `queue-manager/state.ts`).

## Business Logic / Control Flow

### Primitives

**`AsyncLock`** is a FIFO mutex with direct ownership handoff. An uncontested caller reserves `locked` immediately. A release selects the oldest live waiter, marks the lock owned **before** resolving that waiter's promise, and only then schedules the continuation. A newcomer therefore cannot observe an unlocked gap and barge ahead of an already queued owner. Timed-out entries settle once and are lazily skipped; a grant clears its timer. `release` is idempotent, so a stale double-release cannot clobber the next owner's state.

**`RWLock`** allows many readers or one writer with **writer priority** and FIFO writers. A writer release directly reserves `writer = true` for the oldest live writer before resolving it. Only when no live writer remains does the dispatcher reserve and release the queued reader cohort. New readers cannot bypass a waiting writer. Timeout cancellation decrements `writerWaiting` exactly once and re-runs the dispatcher, so the last timed-out writer immediately unblocks compatible readers and cannot leave phantom ownership. Read and write guards are idempotent. The direct-handoff regressions cover late newcomers, 16/64-way FIFO contention, cancelled queue heads, timeout-zero cleanup, and timers firing after grant; the public contention regression runs 8,000 batched completions in both embedded and TCP modes.

**`Semaphore`** bounds concurrency. `acquire` consumes a permit or parks a resolver; `release` hands the permit directly to the next waiter (no counter round-trip) or, with no waiters, increments back up to `maxPermits` (semaphore.ts:39–48). Used by the TCP server: each connection holds a `Semaphore(MAX_CONCURRENT_PER_CONNECTION = 50)` and wraps every frame's command handling in `withSemaphore` (tcp.ts:27, 197, 284), capping in-flight pipelined commands per socket.

### Lease lifecycle

1. **Acquire** — on `PULL`, `pullWithLock` calls `createLock(jobId, owner, ctx, ttl)` (`queue-manager/delivery.ts`). `createLock` (lockOperations.ts:20–44) returns `null` unless the job is in `processing`; an existing lease of the same processing generation also returns `null` (defensive against double-lease), while a lease from an earlier generation is replaced and its client ownership detached (`detachClientJob`).
2. **Renew** — `JobHeartbeat`/`ExtendLock` → `renewJobLock`. Fails if no lock, token mismatch, or already expired (in which case the stale lock is deleted) (lockOperations.ts:62–87). On success it also refreshes `job.lastHeartbeat` for legacy stall detection (lockOperations.ts:79–84).
3. **Authorize and release** — `ACK`, `FAIL`, result-bearing/bare `ACKB`, and
   every active-state move first call `assertLeaseToken`. If a lock record
   exists, omitting the token or presenting a different token rejects the
   entire operation before state is changed; the exact current token is
   required in embedded and TCP mode. An active job with no lock can still be
   moved administratively. A successful transition removes the lease through
   `releaseLock` or `releaseClaimedJobOwnership`.

Manual management claims are also terminal for the current lease even when the
job itself is requeued. `releaseClaimedJobOwnership` removes the `jobLocks`
entry and detaches the id from its `clientJobs` owner (`detachClientJob`, O(1)
through the `clientJobOwners` reverse index) in the same synchronous
processing-map claim used by `moveActiveToWait`, `moveToWaitingChildren`,
`moveJobToDelayed`, and active `discardJob`. Both deletions are idempotent, so a
concurrent disconnect cleanup cannot leave a lease behind or release the
requeued job a second time.

The PostgreSQL multi-broker adapter applies the same generation rule across its
asynchronous boundary: both awaited and fire-and-forget disconnect cleanup
capture every `(jobId, token)` before the first await/enqueue. The SQL release is
fenced by that immutable token, and local token removal is conditional on the
same value still being current. Release progress is retained as a per-client
session: a transient SQL error leaves the current and unprocessed tokens pending,
retries return the cumulative definitive release count, and concurrent cleanup
callers share one in-flight attempt. A deferred callback from an old custom-ID
generation therefore cannot release or erase a newer lease. This does not
change the synchronous memory/SQLite lock implementation described above.

The PostgreSQL manager also places a reentrant lifecycle gate around every
database-backed public operation. Once shutdown closes admission, late work is
rejected before it can reach the SQL pool; work accepted earlier retains its
scope through the authoritative database transition and any bounded immediate
queue reconciliation. Nested manager calls reuse that
scope, synchronous compatibility mutations atomically reserve their deferred
write slot, and escaped async descendants cannot borrow a scope after it has
settled. A long-poll owns admission only during each actual claim transaction,
so an empty pull cannot hold shutdown open. Disconnect cleanup that arrives
after the boundary is local-only and idempotent.

Journal delivery and local claim delivery use different authority boundaries.
An event only schedules a current-row projection; it never clears a token from
its historical payload. A direct claim increments that job's projection
generation before publishing the token locally, so a read already in flight is
discarded. Only a later authoritative row that is non-active or carries another
token may remove local ownership. Queue projections and manager bootstrap views
are read-only repeatable-read transactions, avoiding mixed snapshots across
jobs, results, queue policy, and queue existence.

PostgreSQL DLQ auto-retry follows the distributed lock order even though it
must read completion evidence. It discovers the bounded candidate/dependency
identity set without row locks, takes queue-policy share locks, acquires all
consumer and dependency completion advisory locks in sorted order, and only
then locks failed rows. Current dependency edges and retry policy are re-read
after those waits; a late edge outside the prelocked set is deferred to the next
sweep. Generation reuse and tombstone retirement therefore serialize before a
consumer becomes runnable, and four brokers can inspect the same candidate
without duplicating its retry event.

### Outcome ownership check + #101 grace window

`assertLeaseToken` (`queue-manager/delivery.ts`) checks token identity rather
than lease expiry. This preserves the #101 grace window: an expired lock entry
that still belongs to the current processing generation may complete. The
generation guard requires `job.startedAt <= lock.createdAt`; after a stall
retry is pulled again, the new `startedAt` makes the old outcome invalid even
if a stale lock record remains. A late failure after expiry cleanup is ignored
when the lock has already gone and the job is already queued as a stall retry;
it cannot fail that new attempt. If another owner has installed a current lock,
the stale token is rejected.

Batch acknowledgement performs this ownership preflight for every positional
`id`/`token` pair before extracting any job. A missing or wrong token therefore
leaves every job, result, and lock in the batch unchanged. TCP also rejects
misaligned `ids`, `tokens`, or `results` arrays before invoking the manager.

### `checkExpiredLocks` (lock-expiry sweep)

Runs on the background timer at `stallCheckMs` (5 s), registered in `background/lifecycle.ts`. Three phases (lockManager.ts:42):

1. **Collect** (lock-free read) — scan `ctx.jobLocks`; for each `isLockExpired` lock, look up the job in its processing shard. If the job is gone, or the lease belongs to an earlier processing generation (`isLeaseFromEarlierGeneration`: stall retry kept it as a stale-outcome guard and the job was delivered again without a lease), no live delivery holds it: delete the orphan lease and leave the job alone (lockManager.ts:55–70). A newer lockless delivery is governed by stall detection, not by an earlier delivery's lease; before this rule that lease's expiry requeued the newer delivery (`test/repro-recovery-sweeps-current-generation.test.ts`).
2. **Group** by `shardIdx` then `procIdx` (lockManager.ts:74–89) so locks are acquired in hierarchy order.
3. **Process** under `withWriteLock(shardLocks[shardIdx])` → `withWriteLock(processingLocks[procIdx])` (lockManager.ts:91–114). Before mutating, revalidate that the processing map still contains the collected job object, the lock table still contains the same lease object, that lease is still expired, and it still belongs to the delivery in processing (the job object is reused by its next delivery, so object identity alone cannot tell deliveries apart). This makes overlapping sweeps idempotent and rejects a renewal, ACK, or new delivery generation that won after collection. For each surviving job (`processExpiredLockInner`, lockManager.ts:122):
   - Remove from processing and detach the owning client connection (`detachClientJob`).
   - `cron:` jobs with preventOverlap are **discarded**, not requeued (#75) — record the exact retired lease token in a bounded map, release resources, drop from the index, and delete from SQLite (lockManager.ts:143–150).
   - Otherwise: `attempts++`, `startedAt = null`, `stallCount++`. If `attempts >= maxAttempts` or `stallCount >= maxStalls` → terminal DLQ and ordered `Stalled` → `Failed` broadcasts; otherwise `requeueExpiredJob` and a `Stalled` broadcast.
   - Delete the lock and emit `job:lock-expired`.

`handleRecoveryBoundExceeded` calls `releaseJobResources` (else the concurrency slot leaks), `addToDlq`, then **persists both** `saveDlqEntry` and `deleteJob` — without both writes the `jobs` row survives as an orphan and a later retry re-inserts it, throwing `UNIQUE constraint failed: jobs.id` (#97). Those two writes require the caller's `LockContext` to carry `storage`: the background sweep's context builder omitted it until #110, so the persistence silently no-op'd on the only production path. `LockContext.storage` is now required (nullable) in `application/types/contexts.ts`, and `background/lifecycle.ts` always supplies it. `requeueExpiredJob` releases resources, re-pushes to the priority queue, re-increments queued counters, and notifies.

The retired cron lease map stores only `(jobId, token)`, is capped by
`maxCompletedJobs`, and remains process-local like the lock table. A late
single or batch worker outcome is a no-op only while the job is absent and the
presented token exactly matches that retired generation. Wrong tokens,
arbitrary missing IDs, and already-completed jobs retain the normal rejection
semantics. Custom-ID admission clears the marker before reusing an ID, so a
stale generation cannot authorize an outcome for its replacement. The same
locked retirement deletes the job row from SQLite, so the discarded cron
generation cannot recover after restart.

### `checkStalledJobs` (two-phase stall detection)

Runs on the background timer at `stallCheckMs` (5 s), registered in `background/lifecycle.ts`. Two-phase to avoid false positives (stallDetection.ts:22):

1. **Phase 1** — for each `jobId` carried over in `ctx.stalledCandidates`, re-check `getStallAction`. If the job vanished or stall detection is disabled, drop the candidate. A still-non-`Keep` action is confirmed (stallDetection.ts:26–48).
2. **Phase 2** — scan all `processingShards`; any job whose `getStallAction !== Keep` becomes a candidate for the **next** cycle (stallDetection.ts:50–63). A job must be flagged stalled in two consecutive cycles before action is taken.
3. **Act** — each confirmed stall goes to `handleStalledJob` with the `stillStalled` re-check (stallDetection.ts:65–79): under both locks the job must still be stalled under the queue's current configuration. A heartbeat, progress update, renewal or new delivery of the same job object that lands while the handler waits for the locks keeps the job; before this re-check the stale confirmation retried it anyway (`test/repro-recovery-sweeps-current-generation.test.ts`).

`getStallAction` → `checkStall` (stall.ts:41): returns `Keep` if `startedAt === null`, still inside `gracePeriod`, or `now - lastHeartbeat <= stallInterval` (per-job `job.stallTimeout` overrides the config interval). Otherwise increments a hypothetical count and returns `MoveToDlq` when `>= maxStalls`, else `Retry`.

`handleStalledJob` (exported from `stallDetection.ts`) re-acquires `shardLocks[idx]` → `processingLocks[procIdx]`, re-verifies that the same job object is still in processing (identity, not just id membership) and, when the caller passes a `StallRecheck`, evaluates it under both locks before acting, then calls `moveStalliedJobToDlq` or `retryStalliedJob`. It returns `true` only when it performed the transition, and every transition detaches the job from its owning client connection (`detachClientJob`), so the silent connection's later disconnect cannot release the job's next delivery. The stall checker passes `stillStalled`; cleanup's orphan recovery (`orphanRecovery.ts`, see [Background Tasks](./background-tasks.md)) passes its whole orphan predicate (stall configuration, grace period, silence window and current-generation lease), so a heartbeat or configuration change that lands while it waits for either lock keeps the job. A confirmed stall that would make `attempts >= maxAttempts` is terminal even when the stall-count action alone said retry. Events/webhooks are broadcast **after** the locked section, only if `handled` (stallDetection.ts:137). `retryStalliedJob` bumps stall count + attempts, computes `runAt = now + calculateBackoff(job)` (exponential w/ jitter), appends timeline entries (capped at `MAX_TIMELINE_ENTRIES`), re-pushes, and persists both retry counters via `updateForRetry`. Both stall paths discard `cron:` preventOverlap jobs instead of retrying/DLQ-ing.

## Concurrency & Locking

**Lock hierarchy** (acquire strictly in this order — CLAUDE.md): `jobIndex` → `completedJobs` → `shards[N]` → `processingShards[N]`. In practice `jobIndex` (a plain `Map`) and `completedJobs` (a `BoundedSet`) are **read lock-free first**, then the two real `RWLock` arrays are taken as write locks in order: `shardLocks[shardIdx]` **before** `processingLocks[procIdx]`. Both `checkExpiredLocks` (lockManager.ts:91–114) and `handleStalledJob` (and therefore cleanup's orphan recovery, which holds no lock of its own when calling it) follow this; `checkExpiredLocks` pre-groups its work by `(shardIdx, procIdx)` specifically so it can take locks in hierarchy order even when many expired locks span shards.

**Lease vs. heartbeat (two independent stall signals).** A job can be reclaimed by either (a) `JobLock` TTL expiry (`checkExpiredLocks`), used when the worker pulled _with_ a lock token, or (b) heartbeat-timeout stall detection (`checkStalledJobs`), driven by `job.lastHeartbeat`/`stallInterval`. `renewJobLock` updates both (lockOperations.ts:79–84), so a worker heartbeating its lease also keeps stall detection satisfied.

**Races handled:**

- _Late ACK after lock expiry_ — the #101 grace window (`isExpiredButOwned`) honors a genuine same-instance completion while rejecting a re-pulled-job double-completion via the `createdAt >= startedAt` guard (`queue-manager/delivery.ts`, through `isLeaseFromEarlierGeneration`).
- _Stall re-lease generation_ — the stall retry path may leave the previous
  lock as a stale-outcome guard while the job is queued. When a later pull has
  a newer `startedAt`, `createLock` atomically replaces that lease and detaches
  any remaining TCP client ownership before the new connection is registered
  (the stall transition itself already detached it). The
  generation rule lives in one helper, `isLeaseFromEarlierGeneration`
  (`domain/job/locks.ts`): a lease is stale when `job.startedAt >
  lock.createdAt`. Pull stamps `startedAt` before the lease is created, so a
  lease from the current pull has `createdAt >= startedAt` and the strict
  comparison keeps a same-millisecond lease current. `createLock`, the lease
  token checks in `queue-manager/delivery.ts`, cleanup's orphan liveness rule
  and the lock-expiry sweep all use it, so an earlier generation's unexpired
  lease never keeps the current generation alive and its expiry never
  reclaims the current generation. A
  duplicate lock request for the same processing generation still returns
  `null`. The stale worker token can therefore neither heartbeat nor complete
  the replacement generation.
- _Concurrent completion vs. stall handler_ — both `checkExpiredLocks` and `handleStalledJob` re-verify the collected job object in `processingShards` under the locks before mutating, so a job completed between phases is skipped and no stale `Stalled`/`Failed` event fires.
- _Overlapping recovery sweeps_ — the stall checker, cleanup's orphan recovery and lock expiry all transition under `shardLocks` → `processingLocks`, and each first re-verifies that the collected job object is still in processing **and** that its own trigger still holds for the current delivery: `stillStalled` (stall configuration and heartbeat age), the orphan predicate, or the same expired lease of the current generation. The first transition removes the job from processing, so the others find nothing to do. Guarantee: one delivery is recovered at most once, whichever sweeps overlap and in either order (cleanup vs cleanup in `test/cleanup-orphan-recovery-guards.test.ts`; cleanup vs stall checker and cleanup vs lock expiry in `test/recovery-sweeps-overlap.test.ts`). Limit: the job object is reused by its next delivery, so a sweep that waited across a recovery **and** a re-delivery judges the new delivery afresh by its own trigger; it acts only if that delivery is itself stalled or expired, which is a legitimate second recovery, not a duplicate of the first.
- _Atomic pull handoff (2.8.31):_ the queue to processing transition happens in one synchronous critical section under the shard write lock: `tryDequeueNextJob` pops the job, inserts it into `processingShards`, and flips the `jobIndex` entry to `processing` before yielding (pull.ts:97-117). The processing-shard `Map` is written without taking `processingLocks` there; this is safe because until the flip no id-targeted critical section can be mid-operation on that id, and it avoids holding the hot shard write lock across an await. `finalizeProcessing` (pull.ts:133) then does only post-await bookkeeping (markActive persistence, counters, broadcast) and re-checks membership in `processingShards` first: if a management op (discard, moveToDelayed, obliterate) claimed the job in between, the pull does not deliver it to the worker.
- _Double release_ — every `LockGuard` is idempotent.

## Edge Cases & Failure Modes

- **Lock timeout** — `acquire`/`acquireRead`/`acquireWrite` throw `LockTimeoutError` after `LOCK_TIMEOUT_MS` (default 5 s). Callers using `withWriteLock` propagate the rejection; background sweeps wrap calls in `.catch(...)` (`background/lifecycle.ts`).
- **Resource-slot leaks** — every reclaim path (`handleRecoveryBoundExceeded`, `requeueExpiredJob`, `moveStalliedJobToDlq`, `retryStalliedJob`) calls `shard.releaseJobResources(queue, uniqueKey, groupId, ownerId)` before moving the job; omitting it wedges the queue's concurrency limiter. Passing `ownerId` also prevents a stale generation from releasing a replacement job's unique key.
- **Orphan SQLite rows (#97)** — DLQ moves must `saveDlqEntry` + `deleteJob`; missing the delete leaves a `jobs` row that collides on retry with `UNIQUE constraint failed: jobs.id`.
- **Cron preventOverlap (#73/#75)** — `cron:`-prefixed jobs are discarded rather than requeued/DLQ'd on stall or lock expiry, since the scheduler re-creates them on the next tick; requeuing would cause "starts right away on reconnect".
- **False-positive suppression** — single-cycle hiccups never trigger action thanks to two-phase detection plus the `gracePeriod` after job start.
- **Generation-aware `createLock`** — returns `null` when the job is not
  processing or the existing lock belongs to the same processing generation.
  A newer `startedAt` is a legitimate stall redelivery and replaces the stale
  lock with a fresh token.
- **Token-less heartbeat** — `jobHeartbeat`/`renewJobLock` without a token just bumps `job.lastHeartbeat`; only the heartbeat-stall path (not the lease-TTL path) is then satisfied.
- **`stallCount` monotonic and durable** — all reclaim mechanisms increment `stallCount`, and `updateForRetry` writes it to `jobs.stall_count`; a job flapping between stall, lock-expiry, and process restart still converges to `maxStalls` → DLQ instead of resetting to zero.
- **Invariant:** `processingLocks` are never acquired before `shardLocks`; violating this risks deadlock against the lifecycle paths in [Job Lifecycle](./job-lifecycle.md).

## Configuration

| Name                            | Default     | Effect                                                                                                                                               |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCK_TIMEOUT_MS` (env)         | `5000`      | Default timeout for `AsyncLock`/`RWLock` acquisition (`lockTimeout.ts`).                                                                             |
| `DEFAULT_LOCK_TTL`              | `30_000` ms | Job lease TTL when `pullWithLock` is called without an explicit `ttl` (`src/domain/job/constants.ts:3`, consumed by `src/domain/job/locks.ts:5-10`). |
| `StallConfig.enabled`           | `true`      | Per-queue toggle for stall detection (stall.ts:21). `false` also opts the queue out of cleanup's orphan recovery (`orphanRecovery.ts`).            |
| `StallConfig.stallInterval`     | `30_000` ms | No-heartbeat window before a job is a stall candidate; per-job `stallTimeout` overrides. Orphan window = `max(30 min, stallTimeout ?? stallInterval)`. |
| `StallConfig.maxStalls`         | `3`         | Stalls before the job is moved to DLQ.                                                                                                               |
| `StallConfig.gracePeriod`       | `5_000` ms  | Quiet period after start before stall checks apply.                                                                                                  |
| `stallCheckMs` (config)         | `5_000` ms  | Interval for **both** `checkStalledJobs` and `checkExpiredLocks` (`application/types/config.ts`, `background/lifecycle.ts`).                         |
| `MAX_CONCURRENT_PER_CONNECTION` | `50`        | Per-socket semaphore permits for pipelined TCP command processing (`server/tcp/constants.ts:1`, constructed at `server/tcp/connections.ts:42`).      |

Per-queue `StallConfig` is set via `queue.setStallConfig({...})` (embedded) and read by the sweeps through `shard.getStallConfig(queue)`.

## Related Docs

- [Core Queue Engine](./core-queue-engine.md)
- [Job Lifecycle](./job-lifecycle.md)
- [Background Tasks](./background-tasks.md)
- [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md)
- [Client SDK: Worker](./client-worker-sdk.md)
- [Dead Letter Queue (DLQ)](./dead-letter-queue.md)
- [TCP Server Command Handlers](./tcp-server-handlers.md)
- [Data Structures](./data-structures.md)
