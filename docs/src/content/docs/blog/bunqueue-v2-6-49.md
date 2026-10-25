---
title: "bunqueue v2.6.49"
description: "Cloud: 20 new remote commands, shared deriveState and mapJob helpers."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-49.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-20"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.49</em></h1>
  <p class="bq-hero-sub">Cloud: 20 new remote commands, shared deriveState and mapJob helpers.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.49

```bash title="bun"
bun add bunqueue@2.6.49
```

```bash title="npm"
npm install bunqueue@2.6.49
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Cloud: 20 new remote commands

Full dashboard control via WebSocket:
- Queue: `obliterate`, `promoteAll`, `retryCompleted`, `rateLimit`, `clearRateLimit`, `concurrency`, `clearConcurrency`, `stallConfig`, `dlqConfig`
- Job: `push`, `priority`, `discard`, `delay`, `updateData`, `clearLogs`
- Webhook: `add`, `remove`, `set-enabled`
- Other: `s3:backup`

## Shared `deriveState` and `mapJob` helpers

Eliminated triplicated state derivation logic in command handlers.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.48](/blog/bunqueue-v2-6-48/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.49) · [Commits since v2.6.48](https://github.com/egeominotti/bunqueue/compare/v2.6.48...v2.6.49) · [Full changelog](/changelog/) · [All posts](/blog/)
