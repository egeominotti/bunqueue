---
title: "bunqueue v2.1.1"
description: "Prometheus + Grafana Monitoring Stack, monitoring Documentation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-04"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.1</em></h1>
  <p class="bq-hero-sub">Prometheus + Grafana Monitoring Stack, monitoring Documentation.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.1.1

```bash title="bun"
bun add bunqueue@2.1.1
```

```bash title="npm"
npm install bunqueue@2.1.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Prometheus + Grafana Monitoring Stack

Complete observability setup:
- Docker Compose profile for one-command monitoring deployment
- Pre-configured Prometheus scraping with 5s interval
- Comprehensive Grafana dashboard with 6 panel rows:
  - Overview: Waiting, Delayed, Active, Completed, DLQ, Workers, Cron, Uptime
  - Throughput: Jobs/sec graphs, queue depth over time
  - Success/Failure: Rate gauges, completed vs failed charts
  - Workers: Count, throughput, utilization gauge
  - Webhooks & Cron: Status and lifetime totals
  - Alerts: Visual indicators for DLQ, failure rate, backlog, workers
- 8 pre-configured Prometheus alert rules:
  - `BunqueueDLQHigh` - DLQ > 100 for 5m (critical)
  - `BunqueueHighFailureRate` - Failure > 5% for 5m (warning)
  - `BunqueueQueueBacklog` - Waiting > 10k for 10m (warning)
  - `BunqueueNoWorkers` - No workers with waiting jobs (critical)
  - `BunqueueServerDown` - Server unreachable (critical)
  - `BunqueueLowThroughput` - < 1 job/s for 10m (warning)
  - `BunqueueWorkerOverload` - Utilization > 95% (warning)
  - `BunqueueJobsStuck` - Active jobs, no completions (warning)

## Monitoring Documentation

New guide at `/guide/monitoring/`

## Changes

- Docker Compose now supports `--profile monitoring` for optional stack

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.1.0](/blog/bunqueue-v2-1-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.1.1) · [Commits since v2.1.0](https://github.com/egeominotti/bunqueue/compare/v2.1.0...v2.1.1) · [Full changelog](/changelog/) · [All posts](/blog/)
