---
title: "bunqueue v2.6.62"
description: "Fixes 1 bug. E2E webhook tests failing after SSRF validation: Added validateWebhookUrls option to QueueManagerConfig so tests using localhost can disable URL validation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-62.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-21"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.62</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. E2E webhook tests failing after SSRF validation: Added validateWebhookUrls option to QueueManagerConfig so tests using localhost can disable URL validation.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.62

```bash title="bun"
bun add bunqueue@2.6.62
```

```bash title="npm"
npm install bunqueue@2.6.62
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **E2E webhook tests failing after SSRF validation**: Added `validateWebhookUrls` option to `QueueManagerConfig` so tests using localhost can disable URL validation.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.60](/blog/bunqueue-v2-6-60/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.62) · [Commits since v2.6.49](https://github.com/egeominotti/bunqueue/compare/v2.6.49...v2.6.62) · [Full changelog](/changelog/) · [All posts](/blog/)
