---
title: "bunqueue v2.7.7"
description: "Fixes 4 bugs. Wrong job state after server restart (Issue #83), getJobState/getJob/job.getState returned unknown/null for completed, failed, and DLQ jobs after restart because jobIndex was not repopulated for completed/DLQ jobs during…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.7</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Wrong job state after server restart (Issue #83), getJobState/getJob/job.getState returned unknown/null for completed, failed, and DLQ jobs after restart because jobIndex was not repopulated for completed/DLQ jobs during…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.7

```bash title="bun"
bun add bunqueue@2.7.7
```

```bash title="npm"
npm install bunqueue@2.7.7
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Wrong job state after server restart** (Issue #83), `getJobState`/`getJob`/`job.getState` returned `unknown`/`null` for completed, failed, and DLQ jobs after restart because `jobIndex` was not repopulated for completed/DLQ jobs during recovery. Now `getJob` and `getJobState` fall back to SQLite when `jobIndex` has no entry, correctly resolving `completed`/`failed`/`prioritized`/`delayed`/`waiting` states post-restart. `recover()` also populates `jobIndex` for restored DLQ entries.
- **Stale `jobs` row retained when job enters DLQ**: `ack.ts` (MaxAttemptsExceeded), `stallDetection.ts`, `queueManager.failParent`, and `jobManagement.moveToFailed` now call `storage.deleteJob(jobId)` after `saveDlqEntry`. Without this, recovery would re-queue DLQ'd jobs as stalled actives on restart (legacy orphan rows also cleaned up via `loadDlqJobIds` guard in Phase 1 recovery).
- **Write-buffer/delete race in SQLite persistence**: When a job was inserted through the 10ms-batched `writeBuffer` then immediately deleted (e.g., `removeOnComplete`), the delete ran synchronously while the insert was still pending in the buffer. On flush, the buffered insert wrote an orphan row with stale state. Added `WriteBuffer.removePending(jobId)` invoked from `deleteJob` to cancel pending inserts before SQL DELETE.
- **DLQ-retried jobs did not survive restart**: `retryDlqJob`, `retryDlqJobs` (bulk), `retryDlqByFilter`, and `processAutoRetry` now re-insert the job into SQLite via `insertJob(job, true)` after pushing to the in-memory queue. Required because the jobs row is deleted when a job enters DLQ.

## Tests

- New `test/issue-83-jobstate-after-restart.test.ts` (4 tests: completed-state post-restart, `jobProxy.getState` post-restart, failed/DLQ state post-restart, retryDlq-ed job persists across restart).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.6](/blog/bunqueue-v2-7-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.7) · [Commits since v2.7.6](https://github.com/egeominotti/bunqueue/compare/v2.7.6...v2.7.7) · [Full changelog](/changelog/) · [All posts](/blog/)
