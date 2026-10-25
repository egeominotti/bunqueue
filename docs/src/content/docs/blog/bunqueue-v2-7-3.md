---
title: "bunqueue v2.7.3"
description: "Fixes 4 bugs. Workflow emitter resilience: Event listeners that throw exceptions no longer break the dispatch chain."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-12"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.3</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Workflow emitter resilience: Event listeners that throw exceptions no longer break the dispatch chain.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.3

```bash title="bun"
bun add bunqueue@2.7.3
```

```bash title="npm"
npm install bunqueue@2.7.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Workflow emitter resilience**: Event listeners that throw exceptions no longer break the dispatch chain. All registered listeners are now called regardless of individual failures.
- **Parallel step error aggregation**: When multiple parallel steps fail, all errors are now reported via `AggregateError` instead of silently discarding all but the first.
- **forEach saga compensation**: `findStepDef()` now correctly matches indexed forEach step names (e.g. `process:0`) back to their definition, enabling proper compensation rollback for forEach iterations.
- **Map node observability**: `executeMap()` now emits `step:started` and `step:completed` events, making map nodes observable like all other node types.

## Tests

- Added 24 workflow engine issue reproduction tests (`test/workflow-issues.test.ts`)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.2](/blog/bunqueue-v2-7-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.3) · [Commits since v2.7.2](https://github.com/egeominotti/bunqueue/compare/v2.7.2...v2.7.3) · [Full changelog](/changelog/) · [All posts](/blog/)
