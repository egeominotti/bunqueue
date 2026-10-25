---
title: "bunqueue v2.6.106"
description: "Fixes 1 bug. Cron upsert now removes orphaned queued jobs: between client disconnect and reconnect, a cron tick could push a job while a stale worker was still within the heartbeat timeout window."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-106.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.106</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron upsert now removes orphaned queued jobs: between client disconnect and reconnect, a cron tick could push a job while a stale worker was still within the heartbeat timeout window.</p>
</div>

#### To install bunqueue v2.6.106

```bash title="bun"
bun add bunqueue@2.6.106
```

```bash title="npm"
npm install bunqueue@2.6.106
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron upsert now removes orphaned queued jobs**: between client disconnect and reconnect, a cron tick could push a job while a stale worker was still within the heartbeat timeout window. This orphaned job would sit in the queue and be pulled immediately when a new worker connected. Now, `upsertJobScheduler` with `preventOverlap` removes any existing queued job with the cron's uniqueKey before re-registering the cron, ensuring a clean slate (fixes #73, code path 6/6).

---

[← bunqueue v2.6.105](/blog/bunqueue-v2-6-105/) · [Full changelog](/changelog/) · [All posts](/blog/)
