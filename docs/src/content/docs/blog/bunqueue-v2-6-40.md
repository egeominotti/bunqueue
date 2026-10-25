---
title: "bunqueue v2.6.40"
description: "bunqueue Cloud."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-40.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.40</em></h1>
  <p class="bq-hero-sub">bunqueue Cloud.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.40

```bash title="bun"
bun add bunqueue@2.6.40
```

```bash title="npm"
npm install bunqueue@2.6.40
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## bunqueue Cloud

Remote dashboard telemetry agent. Connect any bunqueue instance to bunqueue Cloud with just 2 env vars (`BUNQUEUE_CLOUD_URL` + `BUNQUEUE_CLOUD_API_KEY`). Zero overhead when disabled.
- **Snapshot channel**: HTTP POST every 5s with full server state: stats, throughput, latency percentiles, memory, per-queue counts, worker details, cron jobs, storage status, DLQ entries, recent jobs.
- **Event channel**: Outbound WebSocket for real-time job event forwarding (Failed, Stalled, etc.) with configurable filtering.
- **Remote commands (opt-in)**: Dashboard can execute commands on the instance via the same WebSocket: `queue:pause`, `queue:resume`, `queue:drain`, `dlq:retry`, `dlq:purge`, `job:cancel`, `job:promote`, `cron:upsert`, `cron:delete`. Requires `BUNQUEUE_CLOUD_REMOTE_COMMANDS=true`.
- **Multi-instance**: Multiple bunqueue instances can connect to the same dashboard with separate instance IDs and names.
- **Resilience**: Offline snapshot buffer (720 snapshots), circuit breaker, WebSocket auto-reconnect with exponential backoff + jitter, graceful shutdown with final snapshot.
- **Security**: API key auth, optional HMAC-SHA256 signing, job data redaction, remote commands disabled by default.
- **New env vars**: `BUNQUEUE_CLOUD_URL`, `BUNQUEUE_CLOUD_API_KEY`, `BUNQUEUE_CLOUD_INSTANCE_NAME`, `BUNQUEUE_CLOUD_INTERVAL_MS`, `BUNQUEUE_CLOUD_REMOTE_COMMANDS`, `BUNQUEUE_CLOUD_SIGNING_SECRET`, `BUNQUEUE_CLOUD_INCLUDE_JOB_DATA`, `BUNQUEUE_CLOUD_REDACT_FIELDS`, `BUNQUEUE_CLOUD_EVENTS`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.39](/blog/bunqueue-v2-6-39/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.40) · [Commits since v2.6.39](https://github.com/egeominotti/bunqueue/compare/v2.6.39...v2.6.40) · [Full changelog](/changelog/) · [All posts](/blog/)
