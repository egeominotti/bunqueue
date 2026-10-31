---
title: "bunqueue v2.9.21"
description: "TCP workers stop receiving events they never use: draining a backlog is 8–16% faster with one worker, 27–35% faster with four worker processes and 51–60% faster with eight. Typed arrays in job data now arrive with their real bytes over TCP and from SQLite, and two bugs in embedded counts and Simple Mode cancellation are fixed."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-21.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-31"
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.21</em></h1>
  <p class="bq-hero-sub">TCP workers stop receiving events they never use: draining a backlog is 8–16% faster with one worker, 27–35% faster with four worker processes and 51–60% faster with eight. Typed arrays in job data now arrive with their real bytes over TCP and from SQLite, and two bugs in embedded counts and Simple Mode cancellation are fixed.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

v2.9.20 made the server write a batch of events to each worker in one call. This
release removes most of those events altogether. A TCP Worker only needs one event
type, `stalled`, but until now it received, decoded and discarded the `pulled` and
`completed` event of every job in its queue. With several worker processes that
traffic was multiplied by every process.

#### To install bunqueue v2.9.21

```bash title="bun"
bun add bunqueue@2.9.21
```

```bash title="npm"
npm install bunqueue@2.9.21
```

```bash title="docker"
TAG=2.9.21
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## TCP workers no longer pay for events they ignore

Every TCP Worker subscribes to its queue's events so it can report stalled jobs.
The subscription had no filter, so the server encoded and wrote the `pulled` and
`completed` event of each job to every worker connection, and each worker process
decoded them only to drop them.

`SubscribeEvents` now takes an optional `eventTypes` list, and a Worker subscribes
with `eventTypes: ["stalled"]`. The server skips encoding an event that no
subscriber of the queue accepts, and sends a filtered connection only the types it
asked for. Draining 10,000 jobs, the worker processes together now handle far
fewer socket reads (one instrumented run each):

| Worker processes | Socket reads in v2.9.20 | Socket reads in v2.9.21 |
| --- | --- | --- |
| 1 | 21,733 | 1,712 |
| 4 | 81,777 | 1,786 |
| 8 | 161,573 | 1,832 |

Before, the event traffic grew with every process added; now it stays flat.

Draining a backlog over TCP with a memory-mode server, measured three times on the
final code: a run with six samples per version in rotating order at 100,000 jobs,
and a full ABBA run (five samples at 100,000 jobs, three at 1,000,000):

| Workers | v2.9.20 → v2.9.21, rotating, 100k | ABBA, 100k | ABBA, 1M |
| --- | --- | --- | --- |
| 1 Worker, in the producer's process | 72,638 → 84,120 jobs/s (+15.8%) | +13.2% | +13.1% |
| 1 worker process | 69,690 → 78,435 jobs/s (+12.5%) | +8.3% | +12.8% |
| 4 worker processes | 87,539 → 117,750 jobs/s (+34.5%) | +27.3% | +30.2% |
| 8 worker processes | 69,974 → 111,780 jobs/s (+59.7%) | +51.1% | +55.2% |

With four and eight processes the ranges never overlap in any run. With one
worker they overlap in some ABBA rows: at both sizes for one worker process, and at
100,000 jobs for the in-process Worker.

Adding jobs over TCP (`addSeq`, `add`, `addBulk`) to a memory-mode server moved
by -7.8% to +0.9% across the three runs. The largest drop, sequential `addSeq` at
100,000 jobs in the ABBA run, did not repeat in the rotating run (-1.4%) or at
1,000,000 jobs (-3.3%). Against an SQLite server the ABBA run measured -9.1% to
-0.8%, all with overlapping ranges, the largest again for `addSeq` at 100,000
jobs. There we can neither confirm a regression nor rule out a small one. Draining from
SQLite in embedded mode moved by -0.9% to +5.8%, with overlapping ranges, so we
don't count it as a gain.

Without `eventTypes` a connection still receives every type, so `QueueEvents` and
existing clients get exactly the bytes they got before. A server older than this
release ignores the field and keeps sending everything, and the Worker still
filters by `event.eventType` itself, so a new Worker works against an older
server.

## Typed arrays arrive with their real bytes

Over TCP, and from SQLite after a restart, a `Float32Array`, `Uint16Array`,
`Float64Array` or any other non-byte TypedArray in job data, results, progress
or events reached its reader as a `Uint8Array` of the wrong bytes:

```ts
// TCP Worker receiving { vector: new Float32Array([1.5, 2.5]) }
// before: job.data.vector -> 01 02 .. .. .. .. .. ..   (the floats truncated to one
//                                                       byte each, then leftover bytes)
// now:    job.data.vector -> 00 00 c0 3f 00 00 20 40   (the floats' own bytes)
```

msgpackr writes such a view as a `bin` of the right length but copies it element
by element. So it wrote one byte per element and left the rest as whatever its
shared output buffer held from earlier frames, which changed from run to run. A
`DataView` arrived empty, and a `BigInt64Array` made a TCP or durable add throw.
An embedded memory-mode queue never encodes job data, so it was not affected and
still hands workers the original object.

The encoder now writes each of these views as a `bin` of exactly its own bytes,
respecting `byteOffset` and `byteLength`. A TCP or SQLite reader gets a
`Uint8Array`, because the element type is not carried. To read it back, copy the
bytes into a new `Uint8Array` first: a decoded view can start at any offset of a
shared buffer, and a `Float32Array` over that buffer rejects an unaligned offset.

```ts
const bytes = job.data.vector as Uint8Array;
const vector = new Float32Array(new Uint8Array(bytes).buffer); // [1.5, 2.5]
```

Every frame without such a view is byte-identical to before, checked across
53,547 values, and for payloads without binary values the encoder costs nothing measurable:
against the commit just before it, the drains above moved by -0.6% to +1.7%. A
frame that carries a plain `Uint8Array` pays one extra scan (about 9% of its
encode time). Class instances and types an app encodes with its own msgpackr
`addExtension` are left alone. Rows stored with corrupt bytes before this release
are not repaired. The TypeScript SDK (`bunqueue-client`) gets the same fix in its
next release: it currently refuses these views with `SerializationError`.

## Other improvements

- **Benchmark against BullMQ.** A new [Benchmark vs BullMQ](/guide/bullmq-benchmark/)
  page compares bunqueue 2.9.20 with BullMQ 6.4.2 on Redis 8.10.2, in memory and
  on disk. The machine was bare-metal Debian 13 on an AMD Ryzen 9 7950X3D, and
  every number is the median of five runs with its range.
  - In memory, bunqueue adds jobs 1.3–4x faster, drains a backlog 1.1–1.3x faster
    and starts delayed jobs 8.5x (median) closer to their due time.
  - Median pickup latency is level, and BullMQ has the lower p99 at 5,000 and
    10,000 jobs/s.
  - On disk, Redis with AOF is ahead: about 7x on draining a backlog.
  - With a million queued jobs, bunqueue holds about 2.2 GiB and Redis about
    0.6 GiB.
  - The homepage shows the results right after the hero, and `bench/vs-bullmq` is
    the reproducible harness behind them.
- **The `bunqueue-assistant` agent knows the whole API.** It now carries a matrix
  of every public surface, checked against the source: Queue, Worker, flows,
  workflows, MCP tools, the 107 TCP commands, the HTTP endpoints, the CLI and the
  environment variables. For each one it describes the behavior in embedded mode
  and over TCP.

## Bugfixes

- **Embedded `getDelayedCount()` counts every delayed job.** It counted one
  default `getJobs` page, so it never reported more than 100. A queue with 250
  delayed jobs answered 100. It now uses the same counts as `getJobCounts()`, as
  over TCP.
- **Simple Mode processors see the Worker's aborts.** A `Bunqueue` processor kept
  running after its job had ended elsewhere, because the wrapper dropped the
  Worker's signal. The cases were a server-enforced `timeout`,
  `app.worker.cancelJob(id)`, `cancelAllJobs()` and a forced worker close. Now
  `app.getSignal(job.id)` is aborted with the Worker's reason, and any pending
  in-process retry stops. A processor that honours the abort counts it as a
  failure for the circuit breaker, as `app.cancel()` already did. So cancelling
  many running jobs with `cancelAllJobs()` can now open the circuit.

## How these numbers were measured

The throughput figures were measured on native macOS 27.2 on an Apple M5 Max
(18 cores, 64 GB), with Bun 1.4.4 and the final 2.9.21 code.

- **Baseline:** the v2.9.20 column is commit `588fccb8`, which is v2.9.20 plus a
  documentation-only change.
- **Samples:** each sample used a fresh server, database and ports. Each row is
  the median of six samples in an order that rotated every round, or of the ABBA
samples where a table says so.
- **Workers:** `concurrency: 50`, `batchSize: 20` and `heartbeatInterval: 5000`.
- **Clients:** `pingInterval: 0`; the producer used a pool of 8 connections.
- **Socket reads:** counted by an instrumented run of the same drain.
- **Stability:** 24 runs of 2.9.21, in embedded and TCP, memory and SQLite,
  with one and four worker processes at 1,000, 10,000, 100,000 and 1,000,000 jobs.
  Every run delivered each job exactly once and left an empty queue with no
  errors.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.20](/blog/bunqueue-v2-9-20/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.21) · [Commits since v2.9.20](https://github.com/egeominotti/bunqueue/compare/v2.9.20...v2.9.21) · [Full changelog](/changelog/) · [All posts](/blog/)
