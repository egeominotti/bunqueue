---
title: "bunqueue v2.6.1"
description: "Fixes 1 bug and ships 1 addition. Queue#upsertJobScheduler ignoring timezone: The RepeatOpts interface was missing the timezone field, causing a TypeScript error when setting it."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.1</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug and ships 1 addition. Queue#upsertJobScheduler ignoring timezone: The RepeatOpts interface was missing the timezone field, causing a TypeScript error when setting it.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.1

```bash title="bun"
bun add bunqueue@2.6.1
```

```bash title="npm"
npm install bunqueue@2.6.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Regression test for scheduler timezone passthrough (`test/bug-22-scheduler-timezone.test.ts`)

## Bugfixes

- **`Queue#upsertJobScheduler` ignoring timezone**: The `RepeatOpts` interface was missing the `timezone` field, causing a TypeScript error when setting it. Additionally, embedded mode hardcoded `timezone: 'UTC'` and TCP mode did not forward timezone to the server. Now properly accepts and passes through IANA timezone strings (e.g., `"Europe/Rome"`, `"America/New_York"`). ([#22](https://github.com/egeominotti/bunqueue/issues/22))

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.0](/blog/bunqueue-v2-6-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.1) · [Commits since v2.6.0](https://github.com/egeominotti/bunqueue/compare/v2.6.0...v2.6.1) · [Full changelog](/changelog/) · [All posts](/blog/)
