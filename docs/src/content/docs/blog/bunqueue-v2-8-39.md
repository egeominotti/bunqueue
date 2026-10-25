---
title: "bunqueue v2.8.39"
description: "Fixes 4 bugs and ships 2 additions. TCP rate limiting now charges each complete MessagePack frame instead of each socket data event."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-39.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-18"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.39</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs and ships 2 additions. TCP rate limiting now charges each complete MessagePack frame instead of each socket data event.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.39

```bash title="bun"
bun add bunqueue@2.8.39
```

```bash title="npm"
npm install bunqueue@2.8.39
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Real public-TCP production tests now exercise durable enqueueing, worker
  concurrency, retries, delayed jobs, priorities, flow dependencies, restart
  recovery, backpressure, health responsiveness, duplicate-effect detection,
  and complete drain under a large backlog.
- The generated model now covers multi-queue shard isolation and global
  conservation. Retention-boundary, protocol-correlation, stale-dependency,
  and dependency-result regressions bring the executable production register
  to 56 invariants, with the remaining contract-dependent candidates recorded
  explicitly in the internal testing reference.

## Bugfixes

- TCP rate limiting now charges each complete MessagePack frame instead of each
  socket data event. Partial frames consume no quota, coalesced frames are
  limited independently, and overload responses preserve the triggering
  `reqId` so multiplexed clients can settle the correct request.
- Stale dependency cleanup now removes durable SQLite state, buffered writes,
  reverse dependency edges, queue ownership, custom and unique identifiers,
  the global job index, and in-memory waiting state as one revalidated
  transition. Expired dependency-gated jobs can no longer remain readable or
  retain identifiers after garbage collection.

## Bugfixes

- A dependency-result tracker now retains a producer result while at least one
  live consumer edge needs it. Fan-in, fan-out, single and batch ACK,
  `removeOnComplete`, retries, terminal failures, cancellation, cleanup,
  recovery, drain, and obliteration all update the same edge lifecycle.
- Dependency result lookup distinguishes a cached `null` result from a cache
  miss and falls back to durable storage consistently. Normal result-cache
  pressure can no longer make a declared flow lose child results before its
  parent is released.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.38](/blog/bunqueue-v2-8-38/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.39) · [Commits since v2.8.38](https://github.com/egeominotti/bunqueue/compare/v2.8.38...v2.8.39) · [Full changelog](/changelog/) · [All posts](/blog/)
