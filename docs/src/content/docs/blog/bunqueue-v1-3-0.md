---
title: "bunqueue v1.3.0"
description: "Fixes 2 bugs. Cron job scheduling, webhook notifications, job progress tracking, job logs."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-3-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.3.0</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Cron job scheduling, webhook notifications, job progress tracking, job logs.</p>
</div>

#### To install bunqueue v1.3.0

```bash title="bun"
bun add bunqueue@1.3.0
```

```bash title="npm"
npm install bunqueue@1.3.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Cron job scheduling
- Webhook notifications
- Job progress tracking
- Job logs

## Bugfixes

- Memory leak in event listeners
- Race condition in batch acknowledgment

---

[← bunqueue v1.2.0](/blog/bunqueue-v1-2-0/) · [Full changelog](/changelog/) · [All posts](/blog/)
