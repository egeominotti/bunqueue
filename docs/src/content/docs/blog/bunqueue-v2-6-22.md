---
title: "bunqueue v2.6.22"
description: "Fixes 2 bugs. Comprehensive WebSocket pub/sub integration test."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-22.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.22</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Comprehensive WebSocket pub/sub integration test.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.22

```bash title="bun"
bun add bunqueue@2.6.22
```

```bash title="npm"
npm install bunqueue@2.6.22
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Comprehensive WebSocket pub/sub integration test

47 assertions covering all 9 event categories (job lifecycle, queue, DLQ, cron, worker, rate-limit, concurrency, webhook, config, system periodic) plus protocol tests (subscribe, unsubscribe, wildcard, invalid patterns, Ping over WS).

## Bugfixes

- **dlq:added WebSocket event**: Now emitted when a job moves to DLQ after max attempts exceeded. Previously this event was defined but never fired.
- **job:progress WebSocket event**: Progress value now included in event payload. Previously `progress` was `undefined` because the broadcast didn't set the top-level field.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.21](/blog/bunqueue-v2-6-21/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.22) · [Commits since v2.6.21](https://github.com/egeominotti/bunqueue/compare/v2.6.21...v2.6.22) · [Full changelog](/changelog/) · [All posts](/blog/)
