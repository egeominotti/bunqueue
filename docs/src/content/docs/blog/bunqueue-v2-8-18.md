---
title: "bunqueue v2.8.18"
description: "Fixes 1 bug. A Worker leased more jobs than concurrency, inflating the broker's active count and starving other workers (src/client/worker/worker.ts): the #96 fix capped _execution_ (activeJobs) at concurrency, but doPullBatch() computed…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-18.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.18</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. A Worker leased more jobs than concurrency, inflating the broker's active count and starving other workers (src/client/worker/worker.ts): the #96 fix capped _execution_ (activeJobs) at concurrency, but doPullBatch() computed…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.18

```bash title="bun"
bun add bunqueue@2.8.18
```

```bash title="npm"
npm install bunqueue@2.8.18
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **A Worker leased more jobs than `concurrency`, inflating the broker's `active` count and starving other workers** (`src/client/worker/worker.ts`): the #96 fix capped _execution_ (`activeJobs`) at `concurrency`, but `doPullBatch()` computed free slots as `concurrency - activeJobs` and then awaited the pull with no reservation. Two leaks compounded: (1) several concurrent `finally → poll → tryProcess` runs each read the same stale `activeJobs` and each pulled a full batch; (2) a job just pulled by one run sat in the local `pendingJobs` buffer, leased and kept alive by the heartbeat (which renews locks for _all_ `pulledJobIds`, not just running ones), but not yet in `activeJobs`, so an overlapping pull never saw it. With `concurrency: 3` the worker held 5-6 jobs leased (3 running + buffered). `doPullBatch()` now caps the **leased** count (running + buffered + in-flight pulls): a new `pendingPull` counter reserves slots before the await (released in `finally`), and free slots are computed from `pulledJobIds.size` (the true leased set) instead of `activeJobs`. Group pull-ahead is preserved: when a group limiter is set and the buffer holds only group-blocked jobs, the worker still pulls ahead to find runnable jobs from other groups (verified by a liveness regression guard, no deadlock/starvation). Execution concurrency was already correct (no data loss); this fixes lease hoarding, the inflated `active` count, and head-of-line fairness across workers.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.17](/blog/bunqueue-v2-8-17/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.18) · [Commits since v2.8.17](https://github.com/egeominotti/bunqueue/compare/v2.8.17...v2.8.18) · [Full changelog](/changelog/) · [All posts](/blog/)
