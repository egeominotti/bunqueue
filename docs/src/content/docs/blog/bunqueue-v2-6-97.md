---
title: "bunqueue v2.6.97"
description: "Fixes 1 bug. Cron jobs no longer fire immediately on restart: skipMissedOnRestart now defaults to true."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-97.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.97</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron jobs no longer fire immediately on restart: skipMissedOnRestart now defaults to true.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.97

```bash title="bun"
bun add bunqueue@2.6.97
```

```bash title="npm"
npm install bunqueue@2.6.97
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron jobs no longer fire immediately on restart**: `skipMissedOnRestart` now defaults to `true`. Past-due crons recalculate `nextRun` to the next future occurrence instead of executing immediately (fixes #73). Use `skipMissedOnRestart: false` to opt in to catch-up behavior.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.96](/blog/bunqueue-v2-6-96/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.97) · [Commits since v2.6.95](https://github.com/egeominotti/bunqueue/compare/v2.6.95...v2.6.97) · [Full changelog](/changelog/) · [All posts](/blog/)
