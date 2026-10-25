---
title: "bunqueue v2.9.19"
description: "Fixes a getJobs crash on queues with a million jobs and removes O(n) scans from the broker: dashboard counts 4,500x faster at 1M jobs, idle pulls on delayed queues 3,500x faster, 64 MB TCP frames 80x faster."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-19.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-25"
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.19</em></h1>
  <p class="bq-hero-sub">Fixes a getJobs crash on queues with a million jobs and removes O(n) scans from the broker: dashboard counts 4,500x faster at 1M jobs, idle pulls on delayed queues 3,500x faster, 64 MB TCP frames 80x faster.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

This release is about one thing: a broker that does not slow down as it fills up.
Several hot paths scanned every queued job, every connection or every buffered
byte on each request. With small queues nobody noticed. With a million jobs, a
dashboard open and workers polling scheduled queues, those scans added up to a
server that got slower the more work it held.

v2.9.19 replaces them with incremental structures. **Public APIs, options,
events, error messages and results are unchanged**, with one exception: `getJobs`
on very large queues now returns its page instead of throwing. The existing test
suite passes unmodified, and a differential check that drove the previous and
the new engine with the same random operations returned identical answers in
150,000 comparisons.

#### To install bunqueue v2.9.19

```bash title="bun"
bun add bunqueue@2.9.19
```

```bash title="npm"
npm install bunqueue@2.9.19
```

```bash title="docker"
TAG=2.9.19
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Dashboards no longer cost a full scan every 10 ms

The SSE and WebSocket dashboards ask for waiting, prioritized and delayed counts
every 10 ms while events flow. Until now each request walked every queued job.
At a million jobs that is 45 ms of work, repeated a hundred times a second.

Each queue now keeps its counts up to date incrementally from the first time
they are read. A small run-time heap, holding job ids only, moves jobs from
delayed to waiting as time passes, using exactly the classification the scan
used. `getStats`, `getQueuesSummary`, `getPerQueueStats`, the Prometheus exporter
and `getCountsPerPriority` all read the same counters.

| Operation (1M jobs) | v2.9.18 | v2.9.19 |
| --- | --- | --- |
| Queue state counts (dashboard tick) | 45.1 ms | 0.01 ms |
| `getStats` | 41.5 ms | 0.72 ms |
| `getQueuesSummary` | 68.2 ms | 0.30 ms |
| `getPerQueueStats` | 68.0 ms | 0.26 ms |
| `getPrometheusMetrics` | 108.8 ms | 0.31 ms |
| `getCountsPerPriority` | 39.1 ms | 0.003 ms |

Priorities that are not array-index keys (negative or fractional) keep the
previous scan, so the object `getCountsPerPriority` returns keeps the same key
order.

## Polling a queue of scheduled jobs is O(1)

A worker polling a queue that holds only future jobs used to park every delayed
job and restore it on each pull, O(n log n) per poll while holding the shard
lock. After a scan finds nothing due, the queue now remembers the earliest time
any job can become ready or expire and answers the next pulls directly, with the
same result: no job, same wake-up time. The tracker is dropped as soon as a scan
dequeues again, so queues with ready jobs pay nothing.

| Queue holding only delayed jobs | v2.9.18 | v2.9.19 |
| --- | --- | --- |
| 50k jobs, each pull after the first | 19,597 µs | 5.6 µs |
| 10k jobs, each pull after the first | 3,585 µs | 3.7 µs |
| 50k jobs, after a new delayed push | 19,545 µs | 0.7 µs |

## Large TCP frames are parsed in linear time

Server and client copied every buffered byte again on each socket read, so one
large frame cost O(size² / chunk). Partial frames now accumulate in a buffer
that doubles with the bytes actually received (never with a length announced in
a header, so a hostile header cannot reserve memory) and shrinks back after a
large frame. Frame bodies are still `Uint8Array` copies, so decoded binary
fields keep their type, and `FrameSizeError` is unchanged.

| Frame (64 KB reads) | v2.9.18 | v2.9.19 |
| --- | --- | --- |
| 64 MB | 5,168.4 ms | 64.8 ms |
| 16 MB | 277.2 ms | 15.6 ms |
| 1 MB | 1.83 ms | 0.85 ms |
| 2,000 × 200 B frames, 512 B reads | 0.171 ms | 0.110 ms |

## Job events reach subscribers without scanning every connection

Each job event used to check every open connection to find the ones subscribed
to its queue. Subscribers are now indexed per queue and still receive events in
connection order.

| Connections × subscribers | v2.9.18 | v2.9.19 |
| --- | --- | --- |
| 10,000 × 1 | 26,258 ns per event | 306 ns |
| 10,000 × 100 | 29,940 ns per event | 1,480 ns |
| 1,000 × 1 | 2,493 ns per event | 240 ns |

## The write buffer is indexed by job id

Lookups, state overrides and removals of buffered jobs scanned both halves of the
double buffer. Each half is now indexed by job id, with the same first match,
insertion order and flush contents.

| Operation | v2.9.18 | v2.9.19 |
| --- | --- | --- |
| Remove, 100k buffered jobs | 491,230 ns | 315 ns |
| Lookup, 100k buffered jobs | 120,424 ns | 203 ns |
| Pull / ack with flushing stalled, 50k buffered | 269.8 / 283.2 µs | 27.6 / 44.3 µs |

## Other improvements

- **Temporal index appends.** A push past the current maximum, the normal case,
  now links behind each skip-list level's tail instead of walking from the head:
  555 → 192 ns per job with a 1M backlog, 404 → 252 ns at 100k.
- **Cached SQLite statements.** The retry, delete, active-dedup,
  waiting-children and flow-failure paths use the statement cache (`db.query`)
  instead of compiling a statement on every call. `fail()` with a retry goes
  from 118.8 to 80.7 µs per job.
- **`getJobs` collection.** Delayed and waiting jobs are collected and tagged in
  one pass, without intermediate arrays: 44.9 → 28.2 ms for a delayed page at 1M
  jobs, 11.4 → 8.1 ms for a waiting page at 100k.
- **Background maintenance.** The 10-second cleanup checks temporal-index
  orphans against the shard's queues directly. At 1M jobs a cleanup tick goes
  from 504 to 405 ms and the empty-queue reconciliation from 343 to 184 ms.
- **Latency histogram.** One bucket per observation, cumulative on read:
  `observe` goes from 12.5 to 9.2 ns.
- **The common path got slightly faster too.** With no delayed jobs (median of
  three runs), `push` goes from 3.33 to 3.11 µs and `pushBatch` from 2.18 to
  1.83 µs per job; `pull` and `ack` are unchanged. With a dashboard reading
  counts every 10 ms, push, pull and ack stay within ±7% of v2.9.18.

## Bugfixes

- **`getJobs` no longer crashes on large queues.** `getJobs` and the helpers
  built on it (`getWaiting`, `getDelayed` and the other list methods) threw
  `RangeError: Maximum call stack size exceeded` past a few hundred thousand
  jobs, because collected jobs were appended with `push(...array)`. The same
  pattern is gone from SQLite pagination overlays, the cloud snapshot wait-time
  statistics and the PostgreSQL DLQ statistics.

  | Backlog | State | v2.9.18 | v2.9.19 |
  | --- | --- | --- | --- |
  | 1M | waiting, page 0..20 | crash | 96.9 ms |
  | 1M | all states, page 0..20 | crash | 111.8 ms |

## Automatic code review on every pull request

Pull requests from this repository now get an automatic Claude Code review, and
owners, members and collaborators can ask for help with `@claude` in issues and
pull requests. Fork pull requests, drafts and bot events are skipped, and both
workflows pin their actions to commit SHAs.

## How these numbers were measured

All figures are diagnostic measurements on Bun 1.4.4, Linux x64, AMD Ryzen 9
7950X3D, in memory mode unless noted, taken with the same script on v2.9.18 and
v2.9.19. They are not results of the official benchmark suite. The differential
check excludes workloads with immediate retries: the order of two equal-priority
jobs retried in the same millisecond also differs between two runs of v2.9.18.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.18](/blog/bunqueue-v2-9-18/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.19) · [Commits since v2.9.18](https://github.com/egeominotti/bunqueue/compare/v2.9.18...v2.9.19) · [Full changelog](/changelog/) · [All posts](/blog/)
