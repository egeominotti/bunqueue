---
title: "bunqueue v2.6.85"
description: "skipIfNoWorker."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-85.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-26"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.85</em></h1>
  <p class="bq-hero-sub">skipIfNoWorker.</p>
</div>

#### To install bunqueue v2.6.85

```bash title="bun"
bun add bunqueue@2.6.85
```

```bash title="npm"
npm install bunqueue@2.6.85
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `skipIfNoWorker`

Option for cron jobs ([#65](https://github.com/egeominotti/bunqueue/issues/65)), when enabled, the cron scheduler skips job creation if no workers are registered for the target queue. Prevents job accumulation when clients go offline while the server keeps running. Works in both embedded and TCP modes.

## More additions

- Schema migration v9: `skip_if_no_worker` column on `cron_jobs` table

---

[← bunqueue v2.6.84](/blog/bunqueue-v2-6-84/) · [Full changelog](/changelog/) · [All posts](/blog/)
