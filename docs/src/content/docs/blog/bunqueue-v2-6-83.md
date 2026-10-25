---
title: "bunqueue v2.6.83"
description: "Fixes 1 bug. immediately: true now works in TCP mode (#65): - Added immediately field to TCP Cron command type - Wired immediately through TCP handler (handleCron) and client TCP path (upsertJobScheduler) - Full TCP parity: immediately…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-83.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.83</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. immediately: true now works in TCP mode (#65): - Added immediately field to TCP Cron command type - Wired immediately through TCP handler (handleCron) and client TCP path (upsertJobScheduler) - Full TCP parity: immediately…</p>
</div>

#### To install bunqueue v2.6.83

```bash title="bun"
bun add bunqueue@2.6.83
```

```bash title="npm"
npm install bunqueue@2.6.83
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`immediately: true` now works in TCP mode** ([#65](https://github.com/egeominotti/bunqueue/issues/65)):
  - Added `immediately` field to TCP `Cron` command type
  - Wired `immediately` through TCP handler (`handleCron`) and client TCP path (`upsertJobScheduler`)
  - Full TCP parity: `immediately`, `skipMissedOnRestart` now work identically in both embedded and TCP modes

---

[← bunqueue v2.6.82](/blog/bunqueue-v2-6-82/) · [Full changelog](/changelog/) · [All posts](/blog/)
