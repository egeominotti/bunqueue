---
title: "bunqueue v2.6.103"
description: "Fixes 1 bug. Cron jobs no longer fire immediately on client reconnect: when a TCP/WebSocket client disconnected while processing a cron job with preventOverlap, releaseClientJobs would re-queue the job as \"waiting\"."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-103.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.103</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron jobs no longer fire immediately on client reconnect: when a TCP/WebSocket client disconnected while processing a cron job with preventOverlap, releaseClientJobs would re-queue the job as "waiting".</p>
</div>

#### To install bunqueue v2.6.103

```bash title="bun"
bun add bunqueue@2.6.103
```

```bash title="npm"
npm install bunqueue@2.6.103
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron jobs no longer fire immediately on client reconnect**: when a TCP/WebSocket client disconnected while processing a cron job with `preventOverlap`, `releaseClientJobs` would re-queue the job as "waiting". On reconnect, the worker would pick it up immediately instead of waiting for the next scheduled time. Now, cron jobs with `preventOverlap` (uniqueKey `cron:*`) are discarded on disconnect, the cron scheduler re-creates them at the next scheduled tick (fixes #73).

---

[← bunqueue v2.6.102](/blog/bunqueue-v2-6-102/) · [Full changelog](/changelog/) · [All posts](/blog/)
