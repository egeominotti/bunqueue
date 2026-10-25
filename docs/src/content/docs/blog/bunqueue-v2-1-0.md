---
title: "bunqueue v2.1.0"
description: "Fixes 4 bugs and ships 3 performance improvements. Hello command, protocol version 2, semaphore utility, fair benchmark comparison and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-04"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.0</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs and ships 3 performance improvements. Hello command, protocol version 2, semaphore utility, fair benchmark comparison and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.1.0

```bash title="bun"
bun add bunqueue@2.1.0
```

```bash title="npm"
npm install bunqueue@2.1.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Hello command

For protocol version negotiation (`cmd: 'Hello'`)

## Protocol version 2

With pipelining capability support

## Semaphore utility

For server-side concurrency limiting (`src/shared/semaphore.ts`)

## Fair benchmark comparison

(`bench/comparison/run.ts`):
- Both bunqueue and BullMQ use identical parallel push strategy
- Queue cleanup with `obliterate()` between tests
- Results: **1.3x Push**, **3.2x Bulk Push**, **1.7x Process** vs BullMQ

## Comprehensive benchmark

(`bench/comprehensive.ts`):
- Embedded vs TCP mode comparison at scales [1K, 5K, 10K, 50K]
- Log suppression for clean output
- Peak results: **287K ops/sec** (Embedded Bulk), **149K ops/sec** (TCP Bulk)
- Embedded mode is **2-4x faster** than TCP across all operations

## New ConnectionOptions

Added `pingInterval`, `commandTimeout`, `pipelining`, `maxInFlight` to public API

## More additions

- Comprehensive pipelining test suites:
  - `test/protocol-reqid.test.ts` - 7 tests for reqId handling
  - `test/client-pipelining.test.ts` - 7 tests for client pipelining
  - `test/server-pipelining.test.ts` - 7 tests for server parallel processing
  - `test/backward-compat.test.ts` - 10 tests for backward compatibility

## Performance

- **TCP Pipelining** - Major throughput improvement for TCP client operations:
  - Client-side: Multiple commands in flight per connection (up to 100 by default)
  - Server-side: Parallel command processing with `Promise.all()`
  - reqId-based response matching for correct command-response pairing
  - **125,000 ops/sec** in pipelining benchmarks (vs ~20,000 before)
  - Configurable via `pipelining: boolean` and `maxInFlight: number` options
- **SQLite indexes for high-throughput operations** - Added 4 new indexes for 30-50% faster queries:
  - `idx_jobs_state_started`: Stall detection now O(log n) instead of O(n) table scan
  - `idx_jobs_group_id`: Fast lookup for group operations
  - `idx_jobs_pending_priority`: Compound index for priority-ordered job retrieval
  - `idx_dlq_entered_at`: DLQ expiration cleanup now O(log n)
- **Date.now() caching in pull loop** - Reduced syscalls by caching timestamp per iteration (+3-5% throughput)

## Changes

- Schema version bumped to 5 (auto-migrates existing databases)
- TCP client now includes `reqId` in all commands for response matching
- Server processes multiple frames in parallel (max 50 concurrent per connection)
- **Documentation**: Rewrote comparison page with real benchmark data and methodology explanation

## Bugfixes

- **SQLITE_BUSY under high concurrency** - Added `PRAGMA busy_timeout = 5000` to wait for locks instead of failing immediately
- **"Database has closed" errors during shutdown** - Added `stopped` flag to WriteBuffer to prevent flush attempts after stop()
- **Critical: Worker pendingJobs race condition** - Concurrent `tryProcess()` calls could overwrite each other's job buffers, causing ~30% job loss under high concurrency. Now preserves existing buffered jobs when pulling new batches.
- **Connection options not passed through** - Worker, Queue, and FlowProducer now correctly pass `pingInterval`, `commandTimeout`, `pipelining`, and `maxInFlight` options to the TCP connection pool.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.0.9](/blog/bunqueue-v2-0-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.1.0) · [Commits since v2.0.9](https://github.com/egeominotti/bunqueue/compare/v2.0.9...v2.1.0) · [Full changelog](/changelog/) · [All posts](/blog/)
