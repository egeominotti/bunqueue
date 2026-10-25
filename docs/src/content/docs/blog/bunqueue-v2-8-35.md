---
title: "bunqueue v2.8.35"
description: "Fixes 5 bugs and ships 3 additions. New Async variants on Queue that resolve only after the server has processed the command: obliterateAsync(), pauseAsync(), resumeAsync(), drainAsync() (returns the removed count), retryDlqAsync(id?) and…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-35.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.35</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs and ships 3 additions. New Async variants on Queue that resolve only after the server has processed the command: obliterateAsync(), pauseAsync(), resumeAsync(), drainAsync() (returns the removed count), retryDlqAsync(id?) and…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.35

```bash title="bun"
bun add bunqueue@2.8.35
```

```bash title="npm"
npm install bunqueue@2.8.35
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- New `Async` variants on `Queue` that resolve only after the server has
  processed the command: `obliterateAsync()`, `pauseAsync()`, `resumeAsync()`,
  `drainAsync()` (returns the removed count), `retryDlqAsync(id?)` and
  `purgeDlqAsync()` (return the server count the fire-and-forget forms
  discard), `setStallConfigAsync()`, `setDlqConfigAsync()`,
  `setGlobalRateLimitAsync()`, `removeGlobalRateLimitAsync()`,
  `setGlobalConcurrencyAsync()`, `removeGlobalConcurrencyAsync()`.
- `getDlqJobsAsync(count?)` lists a remote server's dead jobs over TCP via the
  existing `Dlq` command (plain Job objects; DLQ metadata such as the failure
  reason stays embedded-only).
- Why: fire-and-forget commands travel over a 4-connection pool with no
  ordering guarantee, so `obliterate()` followed by `add()` could wipe the new
  job. The awaitable forms close that race; two TCP test suites were flaky for
  exactly this reason and now use them.

## Bugfixes

- `queue.setGlobalRateLimit(max, duration?)` now means "`max` jobs per
  `duration` ms" in both embedded and TCP modes (default stays 1 second). The
  `RateLimit` wire command and `PUT /queues/:queue/rate-limit` gain optional
  `duration`; invalid values degrade to the defaults instead of failing.
- Previously the client accepted `duration` for BullMQ compatibility and
  silently dropped it: "100 per minute" behaved as "100 per second".

## Bugfixes

- `queue.rateLimit(expireTimeMs)` now sets the limit with a broker-side `ttl`:
  the server clears it by itself, lazily, in embedded and TCP mode alike.
  Previously the expiry was a client-side timer in embedded mode and never
  happened over TCP (the "temporary" limit was permanent). Invalid input now
  throws. TTL'd limits persist across restarts with their remaining time and
  never resurrect once expired (schema migrations 15-16 add
  `queue_state.rate_limit_duration` / `rate_limit_expires_at`, one column per
  migration so interrupted upgrades heal on retry).

## Bugfixes

- The scheduler incremented and persisted `executions` before the skip checks
  (`skipIfNoWorker`, overlap guard), so a skipped fire burned one run of the
  cap without pushing a job — a `skipIfNoWorker` cron with no worker could
  exhaust its entire budget with zero deliveries. Skip decisions now run
  before the increment: a skip advances the schedule and emits `cron:skipped`
  but leaves the budget untouched, so `executions` counts actual deliveries.

## Bugfixes

- `test-flow-advanced` and `test-frameparser-pipelining-e2e` raced their
  fire-and-forget `obliterate()` against the jobs they pushed right after
  (the CI failures on July 17); both now await `obliterateAsync()`. The 20k-row
  recovery regression test gained an explicit timeout for slow CI runners.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.34](/blog/bunqueue-v2-8-34/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.35) · [Commits since v2.8.32](https://github.com/egeominotti/bunqueue/compare/v2.8.32...v2.8.35) · [Full changelog](/changelog/) · [All posts](/blog/)
