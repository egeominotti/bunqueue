---
title: "bunqueue v2.8.15"
description: "Fixes 2 bugs. Queue.getJobCounts() silently returned all zeros in TCP mode (src/client/queue/operations/counts.ts): the sync getJobCounts() hardcoded {waiting:0,…} for the non-embedded branch, so a TCP client got zeros while the server…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-15.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.15</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Queue.getJobCounts() silently returned all zeros in TCP mode (src/client/queue/operations/counts.ts): the sync getJobCounts() hardcoded {waiting:0,…} for the non-embedded branch, so a TCP client got zeros while the server…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Bugfixes

- **`Queue.getJobCounts()` silently returned all zeros in TCP mode** (`src/client/queue/operations/counts.ts`): the sync `getJobCounts()` hardcoded `{waiting:0,…}` for the non-embedded branch, so a TCP client got zeros while the server held the real counts. It now delegates to the async path for TCP (returns an awaitable `Promise<JobCounts>` with the real counts); embedded mode stays synchronous. (`getDelayedCount()` was already async/correct.)
- **PUSH of a late dependent on an evicted `removeOnComplete` parent was wrongly rejected** (`src/infrastructure/server/handlers/core.ts`): the TCP push dependency-existence gate checked `jobIndex`/`completedJobs` but not `depCompletions`, so a child depending on a completed `removeOnComplete` parent was rejected with "Dependency job not found" even though the readiness path and dependency processor already honored it. The gate now also consults `depCompletions` (new `QueueManager.getDepCompletions()` accessor).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.14](/blog/bunqueue-v2-8-14/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.15) · [Commits since v2.8.14](https://github.com/egeominotti/bunqueue/compare/v2.8.14...v2.8.15) · [Full changelog](/changelog/) · [All posts](/blog/)
