---
title: "bunqueue v1.9.4"
description: "5 BullMQ-Compatible Features."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-4.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.4</em></h1>
  <p class="bq-hero-sub">5 BullMQ-Compatible Features.</p>
</div>

#### To install bunqueue v1.9.4

```bash title="bun"
bun add bunqueue@1.9.4
```

```bash title="npm"
npm install bunqueue@1.9.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 5 BullMQ-Compatible Features

- **Timezone support for cron jobs** - IANA timezones (e.g., "Europe/Rome", "America/New_York")
- **`getCountsPerPriority()`** - Get job counts grouped by priority level
- **`getJobs()` with pagination** - Filter by state, paginate with `start`/`end`, sort with `asc`
- **`retryCompleted()`** - Re-queue completed jobs for reprocessing
- **Advanced deduplication** - TTL-based unique keys with `extend` and `replace` strategies

## Changes

- **Documentation improvements**
  - Clear comparison table for Embedded vs TCP Server modes
  - Danger box warning about mixed modes causing "Command timeout" error
  - Added "Connecting from Client" section to Server guide

---

[← bunqueue v1.9.3](/blog/bunqueue-v1-9-3/) · [Full changelog](/changelog/) · [All posts](/blog/)
