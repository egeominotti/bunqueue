---
title: "bunqueue v2.4.5"
description: "Fixes 3 bugs. Backoff jitter - calculateBackoff() now applies jitter to prevent thundering herd when many jobs retry simultaneously."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-5.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.5</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Backoff jitter - calculateBackoff() now applies jitter to prevent thundering herd when many jobs retry simultaneously.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.5

```bash title="bun"
bun add bunqueue@2.4.5
```

```bash title="npm"
npm install bunqueue@2.4.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Backoff jitter** - `calculateBackoff()` now applies jitter to prevent thundering herd when many jobs retry simultaneously. Exponential backoff uses ±50% jitter, fixed backoff uses ±20% jitter around the configured delay.
- **Backoff max cap** - Retry delays are now capped at 1 hour (`DEFAULT_MAX_BACKOFF = 3,600,000ms`) by default. Previously, attempt 20 with 1000ms base produced ~12 day delays. Configurable via `BackoffConfig.maxDelay`.
- **Recovery backoff bypass** - Startup recovery now uses `calculateBackoff(job)` instead of an inline exponential formula, correctly respecting `backoffConfig` (e.g., `{ type: 'fixed', delay: 5000 }` was ignored during recovery).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.3](/blog/bunqueue-v2-4-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.5) · [Commits since v2.4.3](https://github.com/egeominotti/bunqueue/compare/v2.4.3...v2.4.5) · [Full changelog](/changelog/) · [All posts](/blog/)
