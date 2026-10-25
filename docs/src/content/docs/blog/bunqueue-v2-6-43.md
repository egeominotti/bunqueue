---
title: "bunqueue v2.6.43"
description: "Fixes 3 bugs. Cloud: job:list command, cloud: job:get command, cloud: queue:detail command."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-43.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.43</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Cloud: job:list command, cloud: job:get command, cloud: queue:detail command.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.43

```bash title="bun"
bun add bunqueue@2.6.43
```

```bash title="npm"
npm install bunqueue@2.6.43
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Cloud: `job:list` command

Paginated job listing per queue with state filtering (`queue`, `state`, `limit`, `offset`).

## Cloud: `job:get` command

Full job detail with logs and result included.

## Cloud: `queue:detail` command

Queue detail with counts, config, DLQ entries, and job list.

## Bugfixes

- **Cloud: recentJobs now includes completed/failed jobs**: Was only querying waiting/active/delayed states.
- **Cloud: `job:list` total count**: Now returns actual queue count instead of page length.
- **Cloud: activeQueues filter**: Restored skip-empty-queues optimization that was broken by over-broad filter.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.42](/blog/bunqueue-v2-6-42/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.43) · [Commits since v2.6.42](https://github.com/egeominotti/bunqueue/compare/v2.6.42...v2.6.43) · [Full changelog](/changelog/) · [All posts](/blog/)
