---
title: "bunqueue v2.8.44"
description: "Fixes 7 bugs. Scheduled and manual S3 backups now snapshot SQLite through VACUUM INTO, so committed WAL frames are preserved even when a reader blocks checkpoint truncation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-44.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-20"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.44</em></h1>
  <p class="bq-hero-sub">Fixes 7 bugs. Scheduled and manual S3 backups now snapshot SQLite through VACUUM INTO, so committed WAL frames are preserved even when a reader blocks checkpoint truncation.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.44

```bash title="bun"
bun add bunqueue@2.8.44
```

```bash title="npm"
npm install bunqueue@2.8.44
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- Scheduled and manual S3 backups now snapshot SQLite through `VACUUM INTO`,
  so committed WAL frames are preserved even when a reader blocks checkpoint
  truncation. Server snapshots first flush pending buffered writes and reject
  the cycle if storage retry/backoff leaves any accepted write only in memory.
- Backup keys include a UUID; metadata is published before its gzip payload.
  Restore strictly validates metadata, compressed/original sizes, SHA-256,
  SQLite header and `PRAGMA integrity_check`, then quarantines stale
  WAL/SHM/journal sidecars before the atomic swap. Legacy no-metadata restore
  is restricted to uncompressed SQLite files.
- Temporary S3 session credentials and virtual-host addressing are supported.
  Paginated listing now surfaces errors instead of treating an outage as an
  empty bucket, and every S3 retry attempt has a released timeout. Enabling
  backup without a persistent data path now fails startup before binding
  instead of silently running without recovery points.
- Prometheus metrics now use canonical registration gauges and
  `_duration_seconds` histograms, and expose worker capacity, process memory,
  storage health and SQLite size. Health/readiness return 503 for degraded
  storage, TCP connections are reported accurately, and protected metrics fail
  closed when no auth token is configured.
- Enterprise telemetry adds standard `process_*` collectors, bounded build and
  transport labels, an explicit per-queue cardinality cap with exported/omitted
  conservation, and zero-initialized S3 backup scheduler/freshness/outcome
  metrics. The default cap is 100 queue names and is configurable with
  `METRICS_MAX_QUEUES` or `telemetry.maxPrometheusQueues`.
- The pinned Compose monitoring profile now includes Alertmanager, a matching
  Grafana datasource UID, corrected alert expressions, and a dashboard with
  queue filtering, per-queue state, latency percentiles/heatmap, worker
  utilization, storage/server indicators, connections, backup freshness and
  telemetry-cap visibility. Bundled alerts cover stopped/stale/failing backups
  and omitted per-queue metrics.
- New model-based campaigns verify backup publication/restore/retention
  invariants, worker aggregate/capacity conservation, backup outcome
  conservation and queue-label bounds alongside the existing broker lifecycle
  model.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.43](/blog/bunqueue-v2-8-43/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.44) · [Commits since v2.8.43](https://github.com/egeominotti/bunqueue/compare/v2.8.43...v2.8.44) · [Full changelog](/changelog/) · [All posts](/blog/)
