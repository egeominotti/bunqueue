---
title: "bunqueue v2.4.7"
description: "Ships 2 performance improvements and 1 addition. Event-driven cron scheduler - Replaced 1s setInterval polling with precise setTimeout that wakes exactly when the next cron is due."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.7</em></h1>
  <p class="bq-hero-sub">Ships 2 performance improvements and 1 addition. Event-driven cron scheduler - Replaced 1s setInterval polling with precise setTimeout that wakes exactly when the next cron is due.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## What's new

- `scripts/embedded/test-cron-event-driven.ts` - Operational test verifying cron timer precision

## Performance

- **Event-driven cron scheduler** - Replaced 1s `setInterval` polling with precise `setTimeout` that wakes exactly when the next cron is due. Zero wasted ticks between executions:

  | Scenario           | Before                      | After                |
  | ------------------ | --------------------------- | -------------------- |
  | 1 cron every 5min  | 300 ticks/5min (299 wasted) | 1 tick/5min          |
  | 0 crons registered | 1 tick/sec (all wasted)     | 0 ticks              |
  | Cron in 3 hours    | 10,800 wasted ticks         | 1 tick at exact time |

- A 60s `setInterval` safety fallback catches edge cases (timer drift, missed events). Zero functional changes, zero API changes.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.6](/blog/bunqueue-v2-4-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.7) · [Commits since v2.4.6](https://github.com/egeominotti/bunqueue/compare/v2.4.6...v2.4.7) · [Full changelog](/changelog/) · [All posts](/blog/)
