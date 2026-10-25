---
title: "bunqueue v2.3.0"
description: "Ships 2 performance improvements. Latency Histograms, per-Queue Metric Labels, throughput Tracker, LOG_LEVEL Runtime Filtering and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-3-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-06"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.3.0</em></h1>
  <p class="bq-hero-sub">Ships 2 performance improvements. Latency Histograms, per-Queue Metric Labels, throughput Tracker, LOG_LEVEL Runtime Filtering and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.3.0

```bash title="bun"
bun add bunqueue@2.3.0
```

```bash title="npm"
npm install bunqueue@2.3.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Latency Histograms

Prometheus-compatible histograms for push, pull, and ack operations
- Fixed bucket boundaries: 0.1ms to 10,000ms (15 buckets)
- Full exposition format: `_bucket{le="..."}`, `_sum`, `_count`
- Percentile calculation (p50, p95, p99) for SLO tracking
- New files: `src/shared/histogram.ts`, `src/application/latencyTracker.ts`

## Per-Queue Metric Labels

Prometheus labels for per-queue drill-down
- `bunqueue_queue_jobs_waiting{queue="..."}` (waiting, delayed, active, dlq)
- Enables Grafana filtering and alerting per queue name

## Throughput Tracker

Real-time EMA-based rate tracking
- `pushPerSec`, `pullPerSec`, `completePerSec`, `failPerSec`
- O(1) per observation, zero GC pressure
- Replaces placeholder zeros in `/stats` endpoint
- New file: `src/application/throughputTracker.ts`

## LOG_LEVEL Runtime Filtering

`LOG_LEVEL` env var now works at runtime
- Levels: `debug`, `info` (default), `warn`, `error`
- Priority-based filtering with early return

## 39 new telemetry tests

Across 5 test files:
- `test/histogram.test.ts` (9 tests)
- `test/latencyTracker.test.ts` (7 tests)
- `test/perQueueMetrics.test.ts` (7 tests)
- `test/throughputTracker.test.ts` (7 tests)
- `test/telemetry-e2e.test.ts` (9 E2E integration tests)

## Performance

- Telemetry overhead: ~0.003% (~25ns per operation via `Bun.nanoseconds()`)
- Benchmark results unchanged: 197K push/s (embedded), 39K push/s (TCP)

## Changes

- `/stats` endpoint now returns real throughput and latency values
- Monitoring docs updated with per-queue metrics, histogram examples, and logging section
- HTTP API docs updated with new Prometheus output format

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.1.8](/blog/bunqueue-v2-1-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.3.0) · [Commits since v2.1.8](https://github.com/egeominotti/bunqueue/compare/v2.1.8...v2.3.0) · [Full changelog](/changelog/) · [All posts](/blog/)
