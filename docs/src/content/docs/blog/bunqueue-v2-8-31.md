---
title: "bunqueue v2.8.31"
description: "bunqueue 2.8.31 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-31.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.31</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.31 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.31

```bash title="bun"
bun add bunqueue@2.8.31
```

```bash title="npm"
npm install bunqueue@2.8.31
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

Pulling a job popped it from the shard priority queue under the shard write lock while `jobIndex` still said `queue`; only after an await boundary did the index flip to `processing`. A concurrent `getJob`/`GetState` in that window followed the stale location, missed the already-popped queue, and answered `null`/`unknown` for a job that exists and is about to be active, violating the invariant that once `getJob(id)` answers null for a uuidv7 id it must stay null. Found while de-flaking an integration test whose poll loop hit the window reproducibly.

Fix is structural, not reader-side: the pop, the `processingShards` insert and the index flip now happen in the same synchronous critical section, so no observer can ever see queue-but-popped, which repairs every reader at once (`getJob`, `GetState`, `GetJobs`, counts). The old post-await bookkeeping became `finalizeProcessing`, which also detects a management op (discard, moveToDelayed, obliterate) claiming the job between dequeue and finalize and skips delivery, keeping `PULLB` jobs/tokens aligned with no orphan locks. Queries additionally chase moved index entries with a bounded 4-pass walk instead of trusting one stale snapshot. Removing the async lock acquisition from the hot path improved pull+ack throughput about 9% in the focused bench. Regression test: `test/repro-getjob-false-null-during-pull.test.ts` (RED before, GREEN after).

## Bugfixes

The soak marathon's latency-drift check now compares window medians instead of tripping on a single GC pause, the cron maxLimit test ticks until the cap instead of assuming a fixed tick count is enough (and handles the scheduler removing a limit-reached cron), and the embedded retry-backoff suite replaces blind sleeps with condition polling, which is what exposed the false-null bug above.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.30](/blog/bunqueue-v2-8-30/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.31) · [Commits since v2.8.30](https://github.com/egeominotti/bunqueue/compare/v2.8.30...v2.8.31) · [Full changelog](/changelog/) · [All posts](/blog/)
