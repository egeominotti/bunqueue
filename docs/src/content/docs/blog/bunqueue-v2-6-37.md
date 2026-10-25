---
title: "bunqueue v2.6.37"
description: "getJobCounts now returns delayed and paused counts, getJobs supports multiple statuses, GET /queues/summary endpoint."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-37.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.37</em></h1>
  <p class="bq-hero-sub">getJobCounts now returns delayed and paused counts, getJobs supports multiple statuses, GET /queues/summary endpoint.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.37

```bash title="bun"
bun add bunqueue@2.6.37
```

```bash title="npm"
npm install bunqueue@2.6.37
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Removed

- Flaky TCP integration tests (sandboxed-worker, monitoring)

## `getJobCounts` now returns `delayed` and `paused` counts

Matches BullMQ's `getJobCounts()` return type. Both embedded and TCP modes include `delayed` (jobs with future `runAt`) and `paused` (waiting jobs count when queue is paused). ([#56](https://github.com/egeominotti/bunqueue/issues/56))

## `getJobs` supports multiple statuses

Accepts `string | string[]` for the `state` parameter, matching BullMQ's `getJobs(types?: JobType | JobType[])` interface. Works in embedded, TCP, and HTTP (`?state=waiting&state=delayed`). ([#55](https://github.com/egeominotti/bunqueue/issues/55))

## `GET /queues/summary` endpoint

Returns all queues with name, paused status, and job counts in a single HTTP call, replacing N+1 round-trips.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.36](/blog/bunqueue-v2-6-36/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.37) · [Commits since v2.6.36](https://github.com/egeominotti/bunqueue/compare/v2.6.36...v2.6.37) · [Full changelog](/changelog/) · [All posts](/blog/)
