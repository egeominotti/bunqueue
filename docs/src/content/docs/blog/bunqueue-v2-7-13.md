---
title: "bunqueue v2.7.13"
description: "Fixes 6 bugs. WriteBuffer silent data loss when retries exhausted: SqliteStorage previously constructed WriteBuffer without an onCriticalError callback, so jobs dropped after maxRetries (10) vanished with no recovery path (the…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-13.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.13</em></h1>
  <p class="bq-hero-sub">Fixes 6 bugs. WriteBuffer silent data loss when retries exhausted: SqliteStorage previously constructed WriteBuffer without an onCriticalError callback, so jobs dropped after maxRetries (10) vanished with no recovery path (the…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.13

```bash title="bun"
bun add bunqueue@2.7.13
```

```bash title="npm"
npm install bunqueue@2.7.13
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **WriteBuffer silent data loss when retries exhausted**: `SqliteStorage` previously constructed `WriteBuffer` without an `onCriticalError` callback, so jobs dropped after `maxRetries` (10) vanished with no recovery path (the retry-exhaustion branch now lives at `writeBuffer.ts:95-105`). `SqliteStorage` now wires a default handler that logs every lost job (id/queue/customId/priority/data preview), retains the last 100 critical-loss records in memory, and forwards to an optional user `onCriticalLoss` config callback. New API: `storage.getCriticalLosses()` / `storage.clearCriticalLosses()`.
- **`AsyncLock`/`RWLock` double-release broke mutual exclusion**: `guard.release()` had no idempotency check; a stale double-release could clobber the next owner's `locked=true` flag and let two acquirers run concurrently in the critical section, violating the documented lock hierarchy (jobIndex → completedJobs → shards[N] → processingShards[N]). All three guards (`AsyncLock`, `RWLock` read, `RWLock` write) now track a per-guard `released` flag and short-circuit subsequent calls.
- **State-transition writes raced with buffered INSERTs**: `markActive`/`markCompleted`/`markFailed` ran synchronously while the corresponding `insertJob` was still in the 10ms-batched `WriteBuffer`. The `UPDATE` matched 0 rows silently, then the buffered `INSERT` later wrote with the stale insert-time state (`waiting`/`delayed`), clobbering intent. Added `WriteBuffer.hasPending(jobId)` and a private `SqliteStorage.flushIfBuffered(jobId)` helper invoked at the top of every state-mutating method so the row exists on disk before the `UPDATE` runs. If flush fails, in-memory state stays authoritative and the new critical-loss callback records the dropped jobs for log-based recovery.
- **TCP close handler orphaned jobs and leaked `clientJobs` Map entries on retry exhaustion**: `tcp.ts` close handler called `releaseClientJobsWithRetry` (3 attempts with exponential backoff); on persistent lock contention only logged, leaving (a) the `clientJobs` Map entry uncleared (leaks across flapping reconnects) and (b) jobs stuck in `active` state until the full stall timeout (~30s). `clientTracking.releaseClientJobs` now wraps the locked release block in `try/finally` so the Map entry is always deleted. New `forceReleaseClientJobs(clientId)` performs a lock-free best-effort cleanup: clears `clientJobs`, drops orphaned `jobLocks` tokens, and expires both `lastHeartbeat=0` and `startedAt=0` so the stall detector recovers within ~2 ticks (~10s with defaults). `tcp.ts` close handler invokes it in the catch branch as a last-resort fallback.
- **`SandboxedWorker` `Cannot find module` flake on macOS**: Tests using `Bun.write` to create processor files (no fsync) followed by `Worker` spawn could fail with `ModuleNotFound` because the file wasn't yet visible to the fresh Worker process. `createWrapperScript` in `src/client/sandboxed/wrapper.ts` now polls for processor visibility (up to 20×5ms), normalizes the path (removes `TMPDIR`-trailing-slash double slashes), and resolves symlinks (`/var` → `/private/var` on macOS) so the wrapper's `await import(...)` sees the same path Bun's module loader uses.
- **`Client closed` unhandled rejection on intentional TCP shutdown**: `TcpClient.close()` calls `commands.rejectAll(new Error('Client closed'))`, which rejected any in-flight Promises. Callers without a `.catch` in place at that exact microtask (fire-and-forget heartbeats, polling loops mid-await, chained-Promise patterns) produced unhandled rejections and a non-zero process exit during graceful shutdown, causing TCP integration suites (`test-sandboxed-worker.ts`) to fail despite the test cases themselves passing. `connection.ts` `rejectAll` now attaches a silent `.catch` on each command's tracked Promise reference (new `PendingCommand.promise` field) before rejecting. A one-shot `process.on('unhandledRejection')` filter in `TcpClient.close()` catches the rare chained-Promise leak whose `.catch` lives further down the chain.

## Tests

- 4 new reproducer files (13 tests) covering each fixed bug:
  - `test/bug-writebuffer-no-critical-callback.test.ts` (3 tests)
  - `test/bug-asynclock-double-release.test.ts` (4 tests)
  - `test/bug-state-transition-before-buffer-flush.test.ts` (4 tests)
  - `test/bug-tcp-orphan-jobs-on-release-failure.test.ts` (3 tests, including `jobLocks` drop + `startedAt=0` invariants)

## Internal

- `WriteBuffer.hasPending(jobId)`, O(n) linear scan over active + flush buffers (max 200 iters at default size 100). Hot-path overhead acceptable for default 10ms batching; if benchmarks show regressions, switch to a `Set<JobId>` mirror.
- `SqliteStorage` constructor accepts new `onCriticalLoss?: (jobs, error, attempts) => void` callback.
- `QueueManager.forceReleaseClientJobs(clientId): number`, synchronous, returns count of jobs whose state was reset.
- `PendingCommand.promise?: Promise<...>`, optional reference to the caller-visible Promise so `rejectAll` can attach silent `.catch`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.12](/blog/bunqueue-v2-7-12/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.13) · [Commits since v2.7.12](https://github.com/egeominotti/bunqueue/compare/v2.7.12...v2.7.13) · [Full changelog](/changelog/) · [All posts](/blog/)
