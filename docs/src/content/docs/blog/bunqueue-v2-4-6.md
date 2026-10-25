---
title: "bunqueue v2.4.6"
description: "Ships 3 performance improvements and 2 additions. Event-driven dependency resolution - Replaced 100ms setInterval polling with microtask-coalesced flush triggered on job completion."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-6.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.6</em></h1>
  <p class="bq-hero-sub">Ships 3 performance improvements and 2 additions. Event-driven dependency resolution - Replaced 100ms setInterval polling with microtask-coalesced flush triggered on job completion.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.6

```bash title="bun"
bun add bunqueue@2.4.6
```

```bash title="npm"
npm install bunqueue@2.4.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- `src/benchmark/dependency-latency.bench.ts` - Benchmark for dependency chain resolution latency
- `src/application/taskErrorTracking.ts` - Extracted error tracking for reuse across modules

## Performance

- **Event-driven dependency resolution** - Replaced 100ms `setInterval` polling with microtask-coalesced flush triggered on job completion. Dependency chain latency drops from hundreds of milliseconds to microseconds:

  | Scenario              | Before (P50) | After (P50)  | Speedup      |
  | --------------------- | ------------ | ------------ | ------------ |
  | Single dep (A&rarr;B) | 100.05ms     | 12.5&micro;s | **~8,000x**  |
  | Chain (4 levels)      | 300.43ms     | 28.2&micro;s | **~10,700x** |
  | Fan-out (1&rarr;5)    | 100.11ms     | 31.0&micro;s | **~3,200x**  |

- The previous 100ms interval is now a 30s safety fallback. Zero functional changes, zero API changes.
- Bonus: less CPU at idle (no more 10 calls/sec to `processPendingDependencies` when queue is empty).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.5](/blog/bunqueue-v2-4-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.6) · [Commits since v2.4.5](https://github.com/egeominotti/bunqueue/compare/v2.4.5...v2.4.6) · [Full changelog](/changelog/) · [All posts](/blog/)
