---
title: "bunqueue v2.6.98"
description: "Fixes 1 bug. Cron overlap prevention: added preventOverlap option (default: true) that automatically deduplicates cron-fired jobs."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-98.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.98</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron overlap prevention: added preventOverlap option (default: true) that automatically deduplicates cron-fired jobs.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.98

```bash title="bun"
bun add bunqueue@2.6.98
```

```bash title="npm"
npm install bunqueue@2.6.98
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron overlap prevention**: added `preventOverlap` option (default: `true`) that automatically deduplicates cron-fired jobs. When a cron interval is shorter than the job processing time, the scheduler no longer pushes duplicate jobs to the queue. This prevents the "starts right away on restart" issue where accumulated jobs would fire immediately when a worker reconnects (fixes #73).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.97](/blog/bunqueue-v2-6-97/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.98) · [Commits since v2.6.97](https://github.com/egeominotti/bunqueue/compare/v2.6.97...v2.6.98) · [Full changelog](/changelog/) · [All posts](/blog/)
