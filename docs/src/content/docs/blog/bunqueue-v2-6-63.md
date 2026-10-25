---
title: "bunqueue v2.6.63"
description: "Ships 2 performance improvements. WorkerRateLimiter: O(n) → O(1) amortized: Replaced Array.filter() with head-pointer eviction for sliding window token expiration."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-63.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-21"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.63</em></h1>
  <p class="bq-hero-sub">Ships 2 performance improvements. WorkerRateLimiter: O(n) → O(1) amortized: Replaced Array.filter() with head-pointer eviction for sliding window token expiration.</p>
</div>

#### To install bunqueue v2.6.63

```bash title="bun"
bun add bunqueue@2.6.63
```

```bash title="npm"
npm install bunqueue@2.6.63
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

- **WorkerRateLimiter: O(n) → O(1) amortized**: Replaced `Array.filter()` with head-pointer eviction for sliding window token expiration. Eliminates per-poll array allocation and removes `Math.min(...spread)` (potential stack overflow on large token arrays). Benchmarked: 10k tokens went from 31µs to ~0µs per call; zero memory allocation per poll cycle.
- **FlowProducer: parallel sibling creation in TCP mode**: `add()`, `addBulk()`, `addBulkThen()`, and `addTree()` now create independent children/jobs concurrently via `Promise.all`. TCP benchmark shows **3–6x speedup** for flows with 10–20 children (network round-trips overlap instead of serializing). `addBulkThen()` uses `Promise.allSettled` for proper cleanup on partial failure. No impact in embedded mode (pushes are synchronous). `addChain()` unchanged (sequential by design).

---

[← bunqueue v2.6.62](/blog/bunqueue-v2-6-62/) · [Full changelog](/changelog/) · [All posts](/blog/)
