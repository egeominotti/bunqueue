---
title: "bunqueue v2.0.1"
description: "Fixes 1 bug. Critical: jobId deduplication not working after restart - The customIdMap was not populated when recovering jobs from SQLite on server startup."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-0-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.0.1</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Critical: jobId deduplication not working after restart - The customIdMap was not populated when recovering jobs from SQLite on server startup.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.0.1

```bash title="bun"
bun add bunqueue@2.0.1
```

```bash title="npm"
npm install bunqueue@2.0.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Critical: jobId deduplication not working after restart** - The `customIdMap` was not populated when recovering jobs from SQLite on server startup. This caused `getDeduplicationJobId()` to return `null` and allowed duplicate jobs with the same `jobId` to be created.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.0.0](/blog/bunqueue-v2-0-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.0.1) · [Commits since v2.0.0](https://github.com/egeominotti/bunqueue/compare/v2.0.0...v2.0.1) · [Full changelog](/changelog/) · [All posts](/blog/)
