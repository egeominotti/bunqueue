---
title: "bunqueue v2.6.39"
description: "Fixes 3 bugs. Issue #53 test."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-39.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-18"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.39</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Issue #53 test.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.39

```bash title="bun"
bun add bunqueue@2.6.39
```

```bash title="npm"
npm install bunqueue@2.6.39
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Issue #53 test

Regression test for worker `log` event firing.

## Bugfixes

- **`EventType.Paused` / `EventType.Resumed` missing from enum**: Added `Paused` and `Resumed` variants to `EventType` const enum, fixing TypeScript compilation errors in `queueManager.ts` and `client/events.ts`.
- **`UnrecoverableError` / `DelayedError` not exported**: Added `src/client/errors.ts` with BullMQ-compatible error classes (`UnrecoverableError` to skip retries, `DelayedError` to re-delay jobs) and exported them from `bunqueue/client`.
- **Webhook mapping for pause/resume events**: `eventsManager.ts` now handles `Paused` and `Resumed` event types in the webhook switch.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.38](/blog/bunqueue-v2-6-38/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.39) · [Commits since v2.6.37](https://github.com/egeominotti/bunqueue/compare/v2.6.37...v2.6.39) · [Full changelog](/changelog/) · [All posts](/blog/)
