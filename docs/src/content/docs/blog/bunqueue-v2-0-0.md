---
title: "bunqueue v2.0.0"
description: "Complete BullMQ v5 API Compatibility, comprehensive Test Coverage."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-0-0.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.0.0</em></h1>
  <p class="bq-hero-sub">Complete BullMQ v5 API Compatibility, comprehensive Test Coverage.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.0.0

```bash title="bun"
bun add bunqueue@2.0.0
```

```bash title="npm"
npm install bunqueue@2.0.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Complete BullMQ v5 API Compatibility

Full feature parity with BullMQ v5
- **Worker Advanced Methods**
  - `rateLimit(expireTimeMs)` - Apply rate limiting to worker
  - `isRateLimited()` - Check if worker is currently rate limited
  - `startStalledCheckTimer()` - Start stalled job check timer
  - `delay(ms, abortController?)` - Delay worker processing with optional abort
- **Job Advanced Methods**
  - `discard()` - Mark job as discarded
  - `getFailedChildrenValues()` - Get failed children job values
  - `getIgnoredChildrenFailures()` - Get ignored children failures
  - `removeChildDependency()` - Remove child dependency from parent
  - `removeDeduplicationKey()` - Remove deduplication key
  - `removeUnprocessedChildren()` - Remove unprocessed children jobs
- **JobOptions**
  - `continueParentOnFailure` - Continue parent job when child fails
  - `ignoreDependencyOnFailure` - Ignore dependency on failure
  - `timestamp` - Custom job timestamp
- **DeduplicationOptions**
  - `extend` - Extend TTL on duplicate
  - `replace` - Replace existing job on duplicate

## Comprehensive Test Coverage

27 unit tests + 32 embedded script tests for new features

## Changes

- Major version bump to 2.0.0 reflecting complete BullMQ v5 compatibility
- Updated TypeScript types for all new features

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v1.9.9](/blog/bunqueue-v1-9-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.0.0) · [Commits since v1.9.1](https://github.com/egeominotti/bunqueue/compare/v1.9.1...v2.0.0) · [Full changelog](/changelog/) · [All posts](/blog/)
