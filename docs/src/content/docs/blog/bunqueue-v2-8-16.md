---
title: "bunqueue v2.8.16"
description: "Fixes 1 bug. A late ACK from a timed-out worker could phantom-complete a retrying job, silently skipping the retry (src/application/queueManager.ts, src/application/backgroundTasks.ts): for a job with a per-job timeout and attempts > 1…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-16.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.16</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. A late ACK from a timed-out worker could phantom-complete a retrying job, silently skipping the retry (src/application/queueManager.ts, src/application/backgroundTasks.ts): for a job with a per-job timeout and attempts &gt; 1…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Bugfixes

- **A late ACK from a timed-out worker could phantom-complete a retrying job, silently skipping the retry** (`src/application/queueManager.ts`, `src/application/backgroundTasks.ts`): for a job with a per-job `timeout` and `attempts > 1`, the timeout sweep requeued it for retry, but the still-hung worker's late ACK hit the stall-retry recovery path (Issue #33) and completed it anyway, overriding the timeout and skipping the retry. `isStallRetried()` could not distinguish a timeout-requeue from a stall-retry (both are `attempts > 0` in queue). The timeout sweep now records the job in a bounded `timedOutJobs` set; the ACK recovery paths (`ack`, `ackBatch`, `ackBatchWithResults`) discard a stale ACK for such a job (graceful no-op) so the retry proceeds. A legitimate ACK of the retry attempt carries a valid current lock token and bypasses the stale-token recovery path, so it still completes normally. The marker is cleared when a custom id is recycled, so idempotency-key reuse cannot inherit a stale marker.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.15](/blog/bunqueue-v2-8-15/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.16) · [Commits since v2.8.15](https://github.com/egeominotti/bunqueue/compare/v2.8.15...v2.8.16) · [Full changelog](/changelog/) · [All posts](/blog/)
