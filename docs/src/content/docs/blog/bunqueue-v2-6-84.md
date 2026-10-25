---
title: "bunqueue v2.6.84"
description: "Fixes 1 bug. immediately: true conflicting with skipMissedOnRestart (#65): - immediately now only fires on first creation, not on subsequent upserts - Previously, every call to upsertJobScheduler with immediately: true would override…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-84.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.84</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. immediately: true conflicting with skipMissedOnRestart (#65): - immediately now only fires on first creation, not on subsequent upserts - Previously, every call to upsertJobScheduler with immediately: true would override…</p>
</div>

#### To install bunqueue v2.6.84

```bash title="bun"
bun add bunqueue@2.6.84
```

```bash title="npm"
npm install bunqueue@2.6.84
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`immediately: true` conflicting with `skipMissedOnRestart`** ([#65](https://github.com/egeominotti/bunqueue/issues/65)):
  - `immediately` now only fires on **first creation**, not on subsequent upserts
  - Previously, every call to `upsertJobScheduler` with `immediately: true` would override `skipMissedOnRestart` and fire the cron immediately, even after a server restart
  - This was the root cause of the TCP-mode report: the user's app called `upsertJobScheduler` on every startup with both flags, causing the cron to fire immediately despite `skipMissedOnRestart`

---

[← bunqueue v2.6.83](/blog/bunqueue-v2-6-83/) · [Full changelog](/changelog/) · [All posts](/blog/)
