---
title: "bunqueue v2.6.99"
description: "Fixes 1 bug. Cron jobs no longer re-queue on restart: active cron jobs with preventOverlap (default) are now discarded during stall recovery instead of being re-queued."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-99.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.99</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron jobs no longer re-queue on restart: active cron jobs with preventOverlap (default) are now discarded during stall recovery instead of being re-queued.</p>
</div>

#### To install bunqueue v2.6.99

```bash title="bun"
bun add bunqueue@2.6.99
```

```bash title="npm"
npm install bunqueue@2.6.99
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron jobs no longer re-queue on restart**: active cron jobs with `preventOverlap` (default) are now discarded during stall recovery instead of being re-queued. Previously, if a cron job was processing when the server crashed, the recovery mechanism would re-queue it with ~1-3s backoff, causing it to fire immediately on restart. The cron scheduler now handles the next execution at the correct scheduled time (fixes #73).

---

[← bunqueue v2.6.98](/blog/bunqueue-v2-6-98/) · [Full changelog](/changelog/) · [All posts](/blog/)
