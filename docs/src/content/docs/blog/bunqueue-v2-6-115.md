---
title: "bunqueue v2.6.115"
description: "prefixKey, namespace isolation for Queue and Worker."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-115.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-08"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.115</em></h1>
  <p class="bq-hero-sub">prefixKey, namespace isolation for Queue and Worker.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.115

```bash title="bun"
bun add bunqueue@2.6.115
```

```bash title="npm"
npm install bunqueue@2.6.115
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `prefixKey`, namespace isolation for `Queue` and `Worker`

New option lets multiple environments, tenants, or services share the same broker without their jobs, workers, cron schedulers, stats, pause state, DLQ, or rate limits overlapping. `Queue.name` still reports the logical name; the prefix is applied internally to the server-side key. Backward compatible, without `prefixKey`, behavior is identical. Resolves the cron `name` PRIMARY KEY collision in [#77](https://github.com/egeominotti/bunqueue/issues/77). Example:
```typescript
const dev = new Queue('emails', { prefixKey: 'dev:' });
const prod = new Queue('emails', { prefixKey: 'prod:' });
// Workers must match the prefix to consume jobs from the producing queue
new Worker('emails', processor, { prefixKey: 'dev:' });
```
See the [Namespace Isolation guide](/guide/queue/advanced/#namespace-isolation-prefixkey).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.114](/blog/bunqueue-v2-6-114/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.115) · [Commits since v2.6.114](https://github.com/egeominotti/bunqueue/compare/v2.6.114...v2.6.115) · [Full changelog](/changelog/) · [All posts](/blog/)
