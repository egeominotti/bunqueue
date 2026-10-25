---
title: "bunqueue v2.4.3"
description: "Fixes 2 bugs. Batch push now wakes all waiting workers - pushJobBatch previously called notify() only once, causing only 1 of N waiting workers to wake up immediately."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.3</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Batch push now wakes all waiting workers - pushJobBatch previously called notify() only once, causing only 1 of N waiting workers to wake up immediately.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.3

```bash title="bun"
bun add bunqueue@2.4.3
```

```bash title="npm"
npm install bunqueue@2.4.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Batch push now wakes all waiting workers** - `pushJobBatch` previously called `notify()` only once, causing only 1 of N waiting workers to wake up immediately. Others had to wait for their poll timeout (up to 30s with long-poll). Now each inserted job triggers a separate notification, waking all idle workers instantly.
- **Pending notifications counter** - `WaiterManager.pendingNotification` was a boolean flag, silently losing notifications when multiple pushes occurred with no waiting workers. Changed to an integer counter (`pendingNotifications`) so each notification is tracked and consumed individually.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.2](/blog/bunqueue-v2-4-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.3) · [Commits since v2.4.2](https://github.com/egeominotti/bunqueue/compare/v2.4.2...v2.4.3) · [Full changelog](/changelog/) · [All posts](/blog/)
