---
title: "bunqueue v2.8.19"
description: "Fixes 2 bugs. A job that was processed successfully could be recorded as failed when its lock token expired while the handler was running (src/application/queueManager.ts): when lockDuration elapsed without renewal (e.g."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-19.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.19</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. A job that was processed successfully could be recorded as failed when its lock token expired while the handler was running (src/application/queueManager.ts): when lockDuration elapsed without renewal (e.g.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.19

```bash title="bun"
bun add bunqueue@2.8.19
```

```bash title="npm"
npm install bunqueue@2.8.19
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **A job that was processed successfully could be recorded as `failed` when its lock token expired while the handler was running** (`src/application/queueManager.ts`): when `lockDuration` elapsed without renewal (e.g. a half-open TCP storm forcing a worker rebuild on a fresh connection), the handler still finished, but the completion ACK carried the now-expired token. The server rejected it (`Invalid or expired lock token`), the client `AckBatcher` burned its transient retries against this _permanent_ error and dropped the completion, and the job re-pulled → stalled → landed in `failed` despite having been processed correctly every time (observed ~350 jobs and 695× `acks lost` on one production queue). The ACK paths (`ack`, `ackBatch`, `ackBatchWithResults`) now apply a **grace window**: a completion is accepted when the job is still in `processing`, the lock entry's token still matches the presenting worker, and the lock belongs to the _current_ processing instance (`lock.createdAt >= job.startedAt`). The third condition is a **re-lease guard**: the stall path requeues a job without deleting its lock (the lingering lock is load-bearing, the Worker dedups re-pulls via `activeJobIds`, and the lock preserves the original owner's recovery path), so if another worker re-pulls the job its `startedAt` is reset to a newer time than the lingering lock's `createdAt`, the guard denies the grace, and the timed-out worker's late ACK is rejected, preventing a double-completion. In the genuine case (same worker finishing just after its own lock expired, no re-pull) the completion is recorded instead of being lost to a stall. At-least-once delivery already protected the data; this fixes the queue's accounting (success recorded as success).

## Bugfixes

- **A deliberately paused queue silently resumed itself after a server restart, and rate-limit / concurrency overrides reset to defaults** (`src/application/queueManager.ts`, `src/application/backgroundTasks.ts`, `src/infrastructure/persistence/`): the `paused` / `rateLimit` / `concurrencyLimit` state lived only in `LimiterManager`'s in-memory Map. The schema declared a `queue_state` table for exactly this, but nothing read or wrote it, so any restart reset operator intent with no error or warning (a correctness/safety bug: a queue paused for maintenance, or to stop a misbehaving consumer, quietly resumed and processed jobs). The already-declared table is now wired: `pause`/`resume`/`setRateLimit`/`clearRateLimit`/`setConcurrency`/`clearConcurrency` **write through** to `queue_state` (UPSERT; an all-default state deletes the row instead of persisting a placeholder), `obliterate` drops the row, and `recover()` **loads** `queue_state` on boot and applies it to the owning shard. Control-state now survives restarts/upgrades/crashes.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.18](/blog/bunqueue-v2-8-18/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.19) · [Commits since v2.8.18](https://github.com/egeominotti/bunqueue/compare/v2.8.18...v2.8.19) · [Full changelog](/changelog/) · [All posts](/blog/)
