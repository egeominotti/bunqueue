---
title: "bunqueue v2.6.14"
description: "Fixes 12 bugs. CLI double execution: Every CLI command ran twice due to main() being called both on module load and on import."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-14.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.14</em></h1>
  <p class="bq-hero-sub">Fixes 12 bugs. CLI double execution: Every CLI command ran twice due to main() being called both on module load and on import.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.14

```bash title="bun"
bun add bunqueue@2.6.14
```

```bash title="npm"
npm install bunqueue@2.6.14
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **CLI double execution**: Every CLI command ran twice due to `main()` being called both on module load and on import. Added `import.meta.main` guard.
- **CLI ACK/FAIL rejected UUID job IDs**: `parseBigIntArg()` only accepted numeric IDs (`/^\d+$/`) but all job IDs are UUIDs. Now accepts any non-empty string ID.
- **CLI ACK/FAIL always failed**: Each CLI command opens a new TCP connection. When the PULL connection closed, jobs were auto-released back to waiting. ACK on a new connection found the job no longer in processing. Added `detach` flag to PULL command for CLI usage.
- **`job get` showed `State: unknown`**: GetJob response didn't include job state. Now includes state from `getJobState()`.
- **`queue jobs` state column showed `-`**: GetJobs handler didn't include state per job. Now injects state for each returned job.
- **`bunqueue -p <port>` (without `start`) ignored port flag**: Direct mode ignored all CLI flags. Now routes to CLI parser when flags are present.
- **Worker/webhook/cron/logs/metrics list showed `OK`**: Server wraps responses in `{data: {...}}` but CLI formatter only checked top-level keys. Added `unwrap()` helper.
- **Cron list showed `OK`**: Server returns `crons` key but formatter checked for `cronJobs`.
- **Worker/webhook list showed stats instead of entries**: `stats` check ran before `workers`/`webhooks` in formatter priority order.
- **Worker register showed queue list**: Response `queues` field triggered queue list formatter.
- **DLQ list format broken**: Formatter expected `jobId` field but server returns `id`.
- **Metrics showed `OK`**: Prometheus metrics nested in `data.metrics`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.9](/blog/bunqueue-v2-6-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.14) · [Commits since v2.6.9](https://github.com/egeominotti/bunqueue/compare/v2.6.9...v2.6.14) · [Full changelog](/changelog/) · [All posts](/blog/)
