---
title: "bunqueue v2.6.64"
description: "Fixes 1 bug. No-lock ack fails after stall re-queue (data loss): When a worker with useLocks=false processed a job that stall detection re-queued, the ack() call threw \"Job not found\" with no recovery path, leaving the job stuck in the…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-64.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-21"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.64</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. No-lock ack fails after stall re-queue (data loss): When a worker with useLocks=false processed a job that stall detection re-queued, the ack() call threw "Job not found" with no recovery path, leaving the job stuck in the…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.64

```bash title="bun"
bun add bunqueue@2.6.64
```

```bash title="npm"
npm install bunqueue@2.6.64
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **No-lock ack fails after stall re-queue (data loss)**: When a worker with `useLocks=false` processed a job that stall detection re-queued, the `ack()` call threw "Job not found" with no recovery path, leaving the job stuck in the queue forever. The existing Issue #33 handler (`completeStallRetriedJob`) only fired when a lock token was present. Now the handler also fires for tokenless acks when the job was stall-retried (`attempts > 0`), preventing false completions of freshly-pushed jobs.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.63](/blog/bunqueue-v2-6-63/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.64) · [Commits since v2.6.62](https://github.com/egeominotti/bunqueue/compare/v2.6.62...v2.6.64) · [Full changelog](/changelog/) · [All posts](/blog/)
