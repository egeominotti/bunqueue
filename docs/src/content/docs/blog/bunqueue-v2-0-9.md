---
title: "bunqueue v2.0.9"
description: "Fixes 4 bugs and ships 1 addition. Critical: Memory leak in EventsManager - Cancelled waiters in waitForJobCompletion() were never removed from the completionWaiters map on timeout."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-0-9.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.0.9</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs and ships 1 addition. Critical: Memory leak in EventsManager - Cancelled waiters in waitForJobCompletion() were never removed from the completionWaiters map on timeout.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.0.9

```bash title="bun"
bun add bunqueue@2.0.9
```

```bash title="npm"
npm install bunqueue@2.0.9
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Comprehensive test suites for all bug fixes:
  - `test/bug-memory-leak-waiters.test.ts` - 5 tests verifying memory leak fix
  - `test/bug-lost-notification.test.ts` - 4 tests verifying notification fix
  - `test/bug-writebuffer-dataloss.test.ts` - 10 tests verifying WriteBuffer fix
  - `test/bug-verification-remaining.test.ts` - 7 tests verifying CustomId fix and JS concurrency model

## Bugfixes

- **Critical: Memory leak in EventsManager** - Cancelled waiters in `waitForJobCompletion()` were never removed from the `completionWaiters` map on timeout. Now properly cleaned up when timeout fires.
- **Critical: Lost notification TOCTOU race** - Fixed race condition in pull.ts where `notify()` could fire between `tryPullFromShard()` returning null and `waitForJob()` being called. Added `pendingNotification` flag to Shard to capture notifications when no waiters exist.
- **Critical: WriteBuffer data loss** - Added exponential backoff (100ms → 30s), max 10 retries, critical error callback, `stopGracefully()` method, and enhanced error callback with retry information. Previously, persistent errors caused infinite retries and shutdown lost pending jobs.
- **Critical: CustomIdMap race condition** - Concurrent pushes with same customId could create duplicates. Moved customIdMap check inside shard write lock for atomic check-and-insert.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.0.3](/blog/bunqueue-v2-0-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.0.9) · [Commits since v2.0.3](https://github.com/egeominotti/bunqueue/compare/v2.0.3...v2.0.9) · [Full changelog](/changelog/) · [All posts](/blog/)
