---
title: "bunqueue v2.8.14"
description: "Fixes 8 bugs. Concurrency slot leak on lock expiry (lockManager.ts): requeueExpiredJob / handleMaxStallsExceeded now call shard.releaseJobResources() before re-queue/DLQ, mirroring the stall-detection paths."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-14.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.14</em></h1>
  <p class="bq-hero-sub">Fixes 8 bugs. Concurrency slot leak on lock expiry (lockManager.ts): requeueExpiredJob / handleMaxStallsExceeded now call shard.releaseJobResources() before re-queue/DLQ, mirroring the stall-detection paths.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Bugfixes

The data plane was already bulletproof under the destruction test (exactly-once held through a SIGKILL flood, zero corruption, lossless crash recovery, bad-input isolation). These fixes close feature-conditional defects in the control plane and resource hygiene. No change to data correctness or process stability for the default producer/consumer path.

- **Concurrency slot leak on lock expiry** (`lockManager.ts`): `requeueExpiredJob` / `handleMaxStallsExceeded` now call `shard.releaseJobResources()` before re-queue/DLQ, mirroring the stall-detection paths. Previously a queue with `setConcurrency(N)` permanently wedged (throughput → 0) after N lock expiries under worker churn.
- **Dependency children orphaned** (`ack.ts`, `ackHelpers.ts`, `dependencyProcessor.ts`, `push.ts`, `backgroundTasks.ts`, `sqlite.ts`): a child `dependsOn` a parent that returned `undefined` (across a restart) or had `removeOnComplete: true` was silently never run and dropped after 1h. Added a bounded `depCompletions` set for removeOnComplete parents and made dependency recovery recognize `state='completed'` rows (not only `job_results`). Fixes late-dependent ordering too.
- **`addBulk` / PUSHB ignored `durable`** (`push.ts`, `sqlite.ts`): durable batch jobs sat in the 10ms write buffer instead of being written immediately like a single durable push. `insertJobsBatch(jobs, durable)` now writes the durable subset to disk atomically (single transaction), bypassing the buffer.
- **Pool socket drop re-dispatched in-flight jobs** (`clientTracking.ts`, `worker.ts`): with `poolSize > 1`, dropping the connection that pulled a job re-queued a job a live worker was still running (double execution). `releaseClientJobs` now skips jobs whose lock was renewed (`renewalCount > 0`); the worker renews just-pulled locks immediately so the window cannot open.
- **`Worker.close()` hang on buffered jobs** (`worker.ts`): a graceful close with group-limited buffered jobs hung forever; `close(true)` could not pre-empt it. Buffered (pulled-but-unstarted) jobs are now requeued on close, the drain waits only on genuinely in-flight jobs, and a force close pre-empts an in-progress graceful close.
- **Worker not re-registered after a TCP reconnect** (`tcpPool.ts`, `worker.ts`): after a transient drop the worker vanished from `ListWorkers` / `getForQueue` while still consuming jobs. The pool now exposes `onReconnect()` and the worker re-registers on reconnect. (Visibility only, no data loss.)
- **`moveToWaitingChildren` stranded the job** (`queryOperations.ts`, `jobManagement.ts`): a job moved to waiting-children was invisible to `getJob` and uncancellable. `getJob` / `getJobByCustomId` / `cancelJob` now consult `waitingChildren`.
- **`perQueueMetrics` unbounded growth** (`queueManager.ts`, `cleanupTasks.ts`): the per-queue metrics map grew one permanent entry per distinct queue name and was not freed by `obliterate()`. It is now LRU-bounded and freed by `obliterate()`; cumulative counters survive a transient drain.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.13](/blog/bunqueue-v2-8-13/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.14) · [Commits since v2.8.13](https://github.com/egeominotti/bunqueue/compare/v2.8.13...v2.8.14) · [Full changelog](/changelog/) · [All posts](/blog/)
