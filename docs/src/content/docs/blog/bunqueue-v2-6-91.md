---
title: "bunqueue v2.6.91"
description: "Simple Mode: 8 advanced features, modular architecture, 50 unit tests, comprehensive documentation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-91.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.91</em></h1>
  <p class="bq-hero-sub">Simple Mode: 8 advanced features, modular architecture, 50 unit tests, comprehensive documentation.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.91

```bash title="bun"
bun add bunqueue@2.6.91
```

```bash title="npm"
npm install bunqueue@2.6.91
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Simple Mode: 8 advanced features

All built on top of existing Queue/Worker APIs with zero core modifications:
- **Batch Processing**: accumulate N jobs, flush on size or timeout, per-job Promise resolution
- **Advanced Retry**: 5 strategies (fixed, exponential, jitter, fibonacci, custom), `retryIf` predicate
- **Graceful Cancellation**: AbortController per job, `cancel()`, `isCancelled()`, `getSignal()`
- **Circuit Breaker**: auto-pause worker after N consecutive failures, half-open recovery
- **Event Triggers**: declarative "on job A complete → create job B" with optional conditions
- **Job TTL**: expire unprocessed jobs, per-name overrides, runtime updates
- **Priority Aging**: automatically boost priority of old waiting/prioritized jobs

## Modular architecture

Each feature in its own file under `src/client/bunqueue/` (max 300 lines each)

## 50 unit tests

For Simple Mode features, 29 integration assertions

## Comprehensive documentation

Super detailed guide with architecture diagrams, code examples, and interaction notes

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.90](/blog/bunqueue-v2-6-90/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.91) · [Commits since v2.6.90](https://github.com/egeominotti/bunqueue/compare/v2.6.90...v2.6.91) · [Full changelog](/changelog/) · [All posts](/blog/)
