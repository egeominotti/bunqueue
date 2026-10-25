---
title: "bunqueue v2.6.107"
description: "Fixes 1 bug. Fix contextFactory test: updated getLockContext test to reflect the storage field added in v2.6.103 for cron job cleanup on disconnect (#73)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-107.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.107</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Fix contextFactory test: updated getLockContext test to reflect the storage field added in v2.6.103 for cron job cleanup on disconnect (#73).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.107

```bash title="bun"
bun add bunqueue@2.6.107
```

```bash title="npm"
npm install bunqueue@2.6.107
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Fix contextFactory test**: updated `getLockContext` test to reflect the `storage` field added in v2.6.103 for cron job cleanup on disconnect (#73).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.106](/blog/bunqueue-v2-6-106/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.107) · [Commits since v2.6.102](https://github.com/egeominotti/bunqueue/compare/v2.6.102...v2.6.107) · [Full changelog](/changelog/) · [All posts](/blog/)
