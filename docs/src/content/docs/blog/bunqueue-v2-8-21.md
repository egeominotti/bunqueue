---
title: "bunqueue v2.8.21"
description: "Ships 2 performance improvements. Temporal index comparator was not a total order (src/domain/queue/temporalManager.ts)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-21.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.21</em></h1>
  <p class="bq-hero-sub">Ships 2 performance improvements. Temporal index comparator was not a total order (src/domain/queue/temporalManager.ts).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.21

```bash title="bun"
bun add bunqueue@2.8.21
```

```bash title="npm"
npm install bunqueue@2.8.21
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

Bulk job insertion (`addBulk` / `PUSHB`) degraded super-linearly with batch size, a single 5,000-job batch dropped to ~5k ops/s while embedded mode stayed flat. Profiling root-caused it to **two independent O(n²) hot paths**, both fixed:

- **Temporal index comparator was not a total order** (`src/domain/queue/temporalManager.ts`). The cleanup index is a `SkipList` ordered by `createdAt` with jobId-based deduplication. In a bulk push `now` is captured once, so every job in the batch shares the same `createdAt`, making every node compare-equal, which (a) turned `SkipList.insert`'s duplicate-check scan into O(n) per insert ⇒ **O(n²) per batch**, and (b) made `SkipList.delete` remove the **WRONG** same-`createdAt` node (it stopped at the first compare-equal node, a latent correctness bug in `removeFromIndex`). Fixed with a total-order comparator `(createdAt, then jobId)`; jobId is a UUIDv7 string, so lexicographic order is a valid total order. Both the insert dedup scan and delete now resolve to the exact `(createdAt, jobId)` node in O(log n). Repro: `test/repro-temporal-onsquared.test.ts` (30k same-`createdAt` inserts: **10,975ms → 27ms**, plus a wrong-delete correctness case).

- **SSE broadcast did per-event work even with zero clients connected** (`src/infrastructure/server/sseHandler.ts`). The TCP server subscribes both `wsHandler` and `sseHandler` to every job event. `wsHandler.broadcast` early-returns when no clients are connected, but `sseHandler.broadcast` did not, so every `pushed` event still paid `JSON.stringify` + `TextEncoder.encode` + ring-buffer churn and, worst of all, `getQueueJobCounts(queue)`, which is O(queue size + jobIndex size). During a bulk push the broadcast fires once per job after all jobs are already queued ⇒ **O(n²)**, even with no dashboard attached (the common high-throughput case). Fixed by mirroring `wsHandler`: `if (this.clients.size === 0) return;`. Behavior is unchanged whenever ≥1 client is connected. Repro: `test/repro-sse-broadcast-noclients.test.ts`.

**Benchmark**, TCP `addBulk`, server in a separate process, same machine, clean DB per run; before/after measured by stashing the two fixes (apples-to-apples). Reusable harness added as `bench/tcp-bench.ts`:

| batch size | before       | after         | speedup |
| ---------- | ------------ | ------------- | ------- |
| 100        | 28,196 ops/s | 63,403 ops/s  | 2.2×    |
| 1,000      | 18,372 ops/s | 126,410 ops/s | 6.9×    |
| 5,000      | 5,276 ops/s  | 170,013 ops/s | **32×** |

Per-job cost went from super-linear (35 → 54 → 190 µs/job) to flat (~6 µs/job), matching embedded-mode throughput. All three suites green (5,663 unit + 59 TCP suites + 36 embedded suites).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.20](/blog/bunqueue-v2-8-20/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.21) · [Commits since v2.8.20](https://github.com/egeominotti/bunqueue/compare/v2.8.20...v2.8.21) · [Full changelog](/changelog/) · [All posts](/blog/)
