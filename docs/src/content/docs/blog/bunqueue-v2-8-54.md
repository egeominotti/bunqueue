---
title: "bunqueue v2.8.54"
description: "Completed 39 previously exposed Queue, Worker, QueueGroup, dependency, DLQ, deduplication, retry, limiter and state-query methods or method families that returned sentinels, ignored public options or behaved differently between embedded…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-54.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.54</em></h1>
  <p class="bq-hero-sub">Completed 39 previously exposed Queue, Worker, QueueGroup, dependency, DLQ, deduplication, retry, limiter and state-query methods or method families that returned sentinels, ignored public options or behaved differently between embedded…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.54

```bash title="bun"
bun add bunqueue@2.8.54
```

```bash title="npm"
npm install bunqueue@2.8.54
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Public API completeness

- Completed 39 previously exposed Queue, Worker, QueueGroup, dependency, DLQ,
  deduplication, retry, limiter and state-query methods or method families that
  returned sentinels, ignored public options or behaved differently between
  embedded and TCP runtimes.
- Wired every one of the 32 non-serialization methods exposed by a DLQ `Job`
  to live queue operations. Deduplication-key release is generation-safe, and
  explicit waiting-children transitions now survive SQLite restart.
- Made unbounded state reads exhaustive beyond the first page, preserved
  ascending and descending ordering, and returned authoritative prioritized
  and waiting-children counts without changing the wire protocol.

## Verification and SDK audit

- Added a dedicated 135-test regression contract with generated properties,
  embedded coverage, real TCP broker coverage and one end-to-end test for each
  DLQ `Job` operation. Lifecycle and persistence changes also pass the
  asynchronous command model and the complete isolated sandbox.
- Documented the core-parity audit for all six network SDKs. None currently
  exposes the complete network-capable core surface; the per-language method
  and semantic gaps are now recorded as an explicit implementation backlog.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.53](/blog/bunqueue-v2-8-53/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.54) · [Commits since v2.8.53](https://github.com/egeominotti/bunqueue/compare/v2.8.53...v2.8.54) · [Full changelog](/changelog/) · [All posts](/blog/)
