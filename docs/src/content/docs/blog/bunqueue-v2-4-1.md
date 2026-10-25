---
title: "bunqueue v2.4.1"
description: "Codebase refactoring - Split 6 large files exceeding 300-line limit into smaller focused modules - src/shared/lru.ts (643 lines) → barrel re-export + 5 modules: lruMap.ts, lruSet.ts, boundedSet.ts, boundedMap.ts, ttlMap.ts -…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-12"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.1</em></h1>
  <p class="bq-hero-sub">Codebase refactoring - Split 6 large files exceeding 300-line limit into smaller focused modules - src/shared/lru.ts (643 lines) → barrel re-export + 5 modules: lruMap.ts, lruSet.ts, boundedSet.ts, boundedMap.ts, ttlMap.ts -…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.1

```bash title="bun"
bun add bunqueue@2.4.1
```

```bash title="npm"
npm install bunqueue@2.4.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Codebase refactoring** - Split 6 large files exceeding 300-line limit into smaller focused modules
  - `src/shared/lru.ts` (643 lines) → barrel re-export + 5 modules: `lruMap.ts`, `lruSet.ts`, `boundedSet.ts`, `boundedMap.ts`, `ttlMap.ts`
  - `src/client/jobConversion.ts` (499 lines) → 269 lines + `jobConversionTypes.ts`, `jobConversionHelpers.ts`
  - `src/domain/queue/shard.ts` (554 lines) → 484 lines + `waiterManager.ts`, `shardCounters.ts`
  - `src/application/queueManager.ts` (820 lines) → 774 lines (moved `getQueueJobCounts` to `statsManager.ts`)
  - `src/client/worker/worker.ts` (843 lines) → 596 lines + `workerRateLimiter.ts`, `workerHeartbeat.ts`, `workerPull.ts`
- All barrel re-exports preserve backward compatibility, zero breaking changes
- 12 new files created, 6 files modified

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.0](/blog/bunqueue-v2-4-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.1) · [Commits since v2.4.0](https://github.com/egeominotti/bunqueue/compare/v2.4.0...v2.4.1) · [Full changelog](/changelog/) · [All posts](/blog/)
