---
title: "bunqueue v2.6.21"
description: "Fixes 1 bug and ships 2 performance improvements. Batch push notifyBatch(): Batch push now wakes all waiting workers correctly via notifyBatch(N) instead of a single notify() call."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-21.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.21</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug and ships 2 performance improvements. Batch push notifyBatch(): Batch push now wakes all waiting workers correctly via notifyBatch(N) instead of a single notify() call.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.21

```bash title="bun"
bun add bunqueue@2.6.21
```

```bash title="npm"
npm install bunqueue@2.6.21
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

- **Batch push notifyBatch()**: Batch push now wakes all waiting workers correctly via `notifyBatch(N)` instead of a single `notify()` call. Each waiter is woken up individually, fixing a bug where only 1 of N workers received jobs immediately.
- **Pre-compiled HTTP route regexes**: All 40+ regex patterns in HTTP route files are now compiled once at module load instead of per-request (~100µs/request savings).

## Security

- **constantTimeEqual timing fix**: Removed early return on length mismatch that leaked token length via timing side-channel.
- **Batch PUSHB data validation**: Individual job data size is now validated in batch push (was only checked in single PUSH), preventing 10MB limit bypass.
- **Dashboard queue name validation**: `GET /dashboard/queues/:queue` now validates queue names like all other endpoints.
- **Error message sanitization**: SQLite/database error messages are no longer leaked to clients in TCP and HTTP error responses.

## Bugfixes

- **Silent error swallowing**: Replaced 7 empty `.catch(() => {})` blocks with proper error logging in addBatcher flush, sandboxed worker stop/kill/restart/heartbeat paths.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.20](/blog/bunqueue-v2-6-20/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.21) · [Commits since v2.6.19](https://github.com/egeominotti/bunqueue/compare/v2.6.19...v2.6.21) · [Full changelog](/changelog/) · [All posts](/blog/)
