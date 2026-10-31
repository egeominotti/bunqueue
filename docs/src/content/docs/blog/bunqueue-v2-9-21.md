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

Adding a worker process should make a queue faster, never slower. v2.9.20 got
closer to that promise by writing each batch of events to a worker in one socket
call. This release asks a blunter question: why send most of those events at all?

A TCP Worker listens to its queue's events for exactly one reason: to notice
`stalled` jobs. Until now the server still sent every worker the `pulled` and
`completed` event of every job. Each worker process decoded that traffic and threw
almost all of it away. Eight worker processes meant eight copies of it.

v2.9.21 stops sending it. On the final release code, four worker processes drain
a backlog 27–35% faster and eight 51–60% faster than on v2.9.20. Along the way we
found and fixed a bug that silently corrupted every `Float32Array` sent over TCP.

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

## Eight worker processes drain a backlog up to 60% faster

The event stream exists for `QueueEvents` and dashboards, which want to see every
job move. A Worker is not that kind of listener, but it used the same unfiltered
subscription. Every job it pulled produced a `pulled` event and every job it
finished produced a `completed` event. The server encoded each of them and wrote it
to every connected worker, and each worker decoded it only to drop it:

<figure class="bq-figure">
<svg viewBox="0 0 720 250" width="100%" role="img" aria-labelledby="fanout-title" style="max-width:720px;font-family:var(--bq-mono);font-size:12px">
  <title id="fanout-title">Event traffic from the server to four worker processes, before and after v2.9.21</title>
  <text x="170" y="20" text-anchor="middle" style="fill:var(--sl-color-text);font-weight:600;font-family:var(--bq-display);font-size:14px">v2.9.20: every event, to every worker</text>
  <text x="550" y="20" text-anchor="middle" style="fill:var(--sl-color-text);font-weight:600;font-family:var(--bq-display);font-size:14px">v2.9.21: only what a worker asked for</text>
  <rect x="120" y="40" width="100" height="34" rx="6" style="fill:var(--bq-surface);stroke:var(--bq-line)"/>
  <text x="170" y="62" text-anchor="middle" style="fill:var(--sl-color-text)">server</text>
  <rect x="500" y="40" width="100" height="34" rx="6" style="fill:var(--bq-surface);stroke:var(--bq-line)"/>
  <text x="550" y="62" text-anchor="middle" style="fill:var(--sl-color-text)">server</text>
  <g style="stroke:var(--bq-red);stroke-width:2.5">
    <line x1="170" y1="74" x2="35" y2="170"/><line x1="170" y1="74" x2="125" y2="170"/>
    <line x1="170" y1="74" x2="215" y2="170"/><line x1="170" y1="74" x2="305" y2="170"/>
  </g>
  <g style="stroke:var(--bq-green);stroke-width:1.5;stroke-dasharray:4 4">
    <line x1="550" y1="74" x2="415" y2="170"/><line x1="550" y1="74" x2="505" y2="170"/>
    <line x1="550" y1="74" x2="595" y2="170"/><line x1="550" y1="74" x2="685" y2="170"/>
  </g>
  <g style="fill:var(--bq-surface);stroke:var(--bq-line)">
    <rect x="5" y="170" width="60" height="30" rx="5"/><rect x="95" y="170" width="60" height="30" rx="5"/>
    <rect x="185" y="170" width="60" height="30" rx="5"/><rect x="275" y="170" width="60" height="30" rx="5"/>
    <rect x="385" y="170" width="60" height="30" rx="5"/><rect x="475" y="170" width="60" height="30" rx="5"/>
    <rect x="565" y="170" width="60" height="30" rx="5"/><rect x="655" y="170" width="60" height="30" rx="5"/>
  </g>
  <g text-anchor="middle" style="fill:var(--sl-color-text)">
    <text x="35" y="190">worker</text><text x="125" y="190">worker</text><text x="215" y="190">worker</text><text x="305" y="190">worker</text>
    <text x="415" y="190">worker</text><text x="505" y="190">worker</text><text x="595" y="190">worker</text><text x="685" y="190">worker</text>
  </g>
  <text x="170" y="228" text-anchor="middle" style="fill:var(--bq-red)">pulled + completed for every job, ×4</text>
  <text x="550" y="228" text-anchor="middle" style="fill:var(--bq-green)">stalled only, when a job stalls</text>
</svg>
<figcaption>Before, every worker received the <code>pulled</code> and <code>completed</code> event of every job, so the total traffic grew with every extra worker process. Now a worker receives only <code>stalled</code> events.</figcaption>
</figure>

The fix is a filter on the subscription itself. `SubscribeEvents` takes an
optional `eventTypes` list of 1 to 32 names. The server sends a filtered
connection only those types, and skips encoding an event that no subscriber of the
queue accepts. A Worker now subscribes like this:

```ts
{ cmd: 'SubscribeEvents', queue: 'emails', eventTypes: ['stalled'] }
```

The effect is easiest to see in how often a worker process wakes up to read its
socket. Draining 10,000 jobs (one instrumented run each), the worker processes
together performed:

| Worker processes | Socket reads in v2.9.20 | Socket reads in v2.9.21 |
| --- | --- | --- |
| 1 | 21,733 | 1,712 |
| 4 | 81,777 | 1,786 |
| 8 | 161,573 | 1,832 |

In v2.9.20 the number of reads grew with the number of processes: eight processes
did 7.4 times the reads of one, for the same 10,000 jobs. Now it stays flat, and
the CPU it used to cost goes back into processing jobs.

### What it is worth

We measured the final release code against v2.9.20 three times, draining a backlog
over TCP with a memory-mode server. The first run used six samples per version in
rotating order at 100,000 jobs. A full ABBA run then took five samples at 100,000
jobs and three at 1,000,000:

| Workers | v2.9.20 → v2.9.21, rotating, 100k | ABBA, 100k | ABBA, 1M |
| --- | --- | --- | --- |
| 1 Worker, in the producer's process | 72,638 → 84,120 jobs/s (+15.8%) | +13.2% | +13.1% |
| 1 worker process | 69,690 → 78,435 jobs/s (+12.5%) | +8.3% | +12.8% |
| 4 worker processes | 87,539 → 117,750 jobs/s (+34.5%) | +27.3% | +30.2% |
| 8 worker processes | 69,974 → 111,780 jobs/s (+59.7%) | +51.1% | +55.2% |

The more processes, the bigger the win, because that is where the duplicated
traffic was largest. With four and eight processes the ranges never overlap in any
run. With one worker they overlap in some ABBA rows: at both sizes for one worker
process, and at 100,000 jobs for the in-process Worker.

We also report what did not move, or might have moved the wrong way:

- **Adding jobs to a memory-mode server** (`addSeq`, `add`, `addBulk`) moved by
  -7.8% to +0.9% across the three runs. The largest drop was sequential `addSeq` at
  100,000 jobs in the ABBA run. It did not repeat in the rotating run (-1.4%) or
  at 1,000,000 jobs (-3.3%).
- **Adding jobs to an SQLite server** measured -9.1% to -0.8% in the ABBA run, all
  with overlapping ranges. The largest was again `addSeq` at 100,000 jobs.
- **Draining from SQLite in embedded mode** moved by -0.9% to +5.8%, with
  overlapping ranges.

For the add paths we can neither confirm a regression nor rule out a small one, and
we don't count the SQLite drain as a gain.

### Nothing breaks on either side

Without `eventTypes` a connection still receives every type, so `QueueEvents`,
dashboards and existing clients get exactly the bytes they got before. A server
older than this release ignores the field and keeps sending everything, and the
Worker still filters by `event.eventType` itself. That means a new Worker works
against an old server, and an old Worker against a new one.

## How we found it, and how we checked it

A CPU profile found it. We profiled a TCP drain with the producer and the Worker in
one client process. `handleData`, the function that reads the socket, took 52.6%
of that process's total time. The function with the most self time was msgpackr's
`readMap`, at 21.1%: the worker was decoding frames, mostly events, only to drop
them.

To check that the filter changed only that, we then wrapped the functions of
bunqueue's queue, worker, client and broker in a call counter. We ran 19 scenarios
through both versions: embedded and TCP, memory and SQLite, adds, bulk adds,
drains, and one, four and eight worker processes. That gave a matrix of 169
functions by 19 scenarios, at 1,000 and 10,000 jobs, plus a CPU profile of each
scenario.

Most rows of the matrix are identical between the versions, which is the point:
the job lifecycle does the same work. The rows that differ are the ones the change
was meant to move:

| Scenario (10,000 jobs) | Function | v2.9.20 | v2.9.21 |
| --- | --- | ---: | ---: |
| 8 worker processes | `TcpClientHealth.handleData` (worker side) | 161,573 | 1,832 |
| 1 worker process | `TcpClientHealth.handleData` (worker side) | 21,733 | 1,712 |
| Embedded drain, SQLite | `QueueManagerQueries.getJob` | 10,000 | 0 |

The last row is a smaller change shipped alongside it. After every completion,
the flow-completion check looked the job up again to learn its parent, once per
job. It now uses the job the completion has just retained in memory, and it
settles on the same microtask as the old lookup, so the order of dashboard events
does not change. In the same pass, deleting a flow failure now reuses one cached
SQLite statement instead of compiling a new one for every completion.

## Typed arrays arrive with their real bytes

A second problem surfaced during the same work, and this one was a correctness
bug. Send a `Float32Array` over TCP and look at what a worker receives:

<figure class="bq-figure">
<svg viewBox="0 0 720 200" width="100%" role="img" aria-labelledby="bytes-title" style="max-width:720px;font-family:var(--bq-mono);font-size:13px">
  <title id="bytes-title">The eight bytes of Float32Array [1.5, 2.5] in memory, as v2.9.20 sent them, and as v2.9.21 sends them</title>
  <g style="fill:var(--sl-color-text)">
    <text x="0" y="42">in memory</text>
    <text x="0" y="102">v2.9.20 sent</text>
    <text x="0" y="162">v2.9.21 sends</text>
  </g>
  <g style="fill:var(--bq-surface);stroke:var(--bq-line)">
    <rect x="150" y="20" width="62" height="34" rx="4"/><rect x="220" y="20" width="62" height="34" rx="4"/><rect x="290" y="20" width="62" height="34" rx="4"/><rect x="360" y="20" width="62" height="34" rx="4"/>
    <rect x="440" y="20" width="62" height="34" rx="4"/><rect x="510" y="20" width="62" height="34" rx="4"/><rect x="580" y="20" width="62" height="34" rx="4"/><rect x="650" y="20" width="62" height="34" rx="4"/>
  </g>
  <g text-anchor="middle" style="fill:var(--sl-color-text)">
    <text x="181" y="42">00</text><text x="251" y="42">00</text><text x="321" y="42">c0</text><text x="391" y="42">3f</text>
    <text x="471" y="42">00</text><text x="541" y="42">00</text><text x="611" y="42">20</text><text x="681" y="42">40</text>
  </g>
  <g style="fill:none;stroke:var(--bq-red);stroke-width:1.5">
    <rect x="150" y="80" width="62" height="34" rx="4"/><rect x="220" y="80" width="62" height="34" rx="4"/>
  </g>
  <g style="fill:var(--bq-red);fill-opacity:0.14;stroke:var(--bq-red);stroke-dasharray:3 3">
    <rect x="290" y="80" width="62" height="34" rx="4"/><rect x="360" y="80" width="62" height="34" rx="4"/>
    <rect x="440" y="80" width="62" height="34" rx="4"/><rect x="510" y="80" width="62" height="34" rx="4"/><rect x="580" y="80" width="62" height="34" rx="4"/><rect x="650" y="80" width="62" height="34" rx="4"/>
  </g>
  <g text-anchor="middle" style="fill:var(--bq-red)">
    <text x="181" y="102">01</text><text x="251" y="102">02</text>
    <text x="321" y="102">??</text><text x="391" y="102">??</text><text x="471" y="102">??</text><text x="541" y="102">??</text><text x="611" y="102">??</text><text x="681" y="102">??</text>
  </g>
  <g style="fill:var(--bq-green);fill-opacity:0.12;stroke:var(--bq-green)">
    <rect x="150" y="140" width="62" height="34" rx="4"/><rect x="220" y="140" width="62" height="34" rx="4"/><rect x="290" y="140" width="62" height="34" rx="4"/><rect x="360" y="140" width="62" height="34" rx="4"/>
    <rect x="440" y="140" width="62" height="34" rx="4"/><rect x="510" y="140" width="62" height="34" rx="4"/><rect x="580" y="140" width="62" height="34" rx="4"/><rect x="650" y="140" width="62" height="34" rx="4"/>
  </g>
  <g text-anchor="middle" style="fill:var(--bq-green)">
    <text x="181" y="162">00</text><text x="251" y="162">00</text><text x="321" y="162">c0</text><text x="391" y="162">3f</text>
    <text x="471" y="162">00</text><text x="541" y="162">00</text><text x="611" y="162">20</text><text x="681" y="162">40</text>
  </g>
  <g text-anchor="middle" style="fill:var(--sl-color-gray-3);font-size:11px">
    <text x="286" y="194">1.5</text><text x="576" y="194">2.5</text>
  </g>
</svg>
<figcaption><code>new Float32Array([1.5, 2.5])</code> is eight bytes. v2.9.20 sent each float cut down to a single byte (1 and 2), followed by six leftover bytes from earlier frames that changed from run to run.</figcaption>
</figure>

The cause is in msgpackr, the MessagePack library bunqueue uses. Without its
`moreTypes` option, it writes any TypedArray as a binary value of the right
length, but fills it with `Uint8Array.prototype.set`. That copies element by
element and converts each element to a byte. 1.5 becomes 1 and 2.5 becomes 2,
and the other six bytes keep whatever the library's shared output buffer held from
earlier frames. Those can be another job's data: in a reproduction with the
v2.9.20 encoder, 58 of 2,000 frames carrying a `Float32Array` also carried bytes
of a different job's payload. With v2.9.21, none did. A `DataView` arrived empty, and a
`BigInt64Array` made a TCP or durable add throw. Every non-byte TypedArray was hit:
`Uint16Array`, `Int32Array`, `Float64Array` and the rest, over TCP and from SQLite
after a restart. An embedded memory-mode queue never encodes job data, so it was
not affected.

### A fix that costs nothing on ordinary frames

Rewriting every frame to look for views would slow down the jobs that carry plain
JSON-like data, which is most of them. So the encoder asks msgpackr instead. msgpackr reads its
`moreTypes` option only when the value it is writing depends on it: a TypedArray
that is not a Buffer, a `DataView`, an `ArrayBuffer`, a `Set`, an `Error` or a
`RegExp`. We give it an option object whose `moreTypes` is a getter that returns
`false`, as the default does, and counts how often it is read:

- **The getter was never read:** the frame cannot contain a view, so it is sent
  exactly as before, in one pass.
- **The getter was read:** a scan checks for a non-byte view. If there is none (for
  example plain `Uint8Array`s), the bytes already written are kept.
- **There is a non-byte view:** the value is rewritten copy-on-write, each view
  replaced by a `Uint8Array` over its own bytes, without copying the data, and
  encoded again.

The result: every frame without such a view is byte-identical to before, checked
across 53,547 values. On the drain benchmarks above, the final code and the commit
just before the fix differ by -0.6% to +1.7%. In our encode
micro-benchmark of a `PUSHB` frame, one that carries a plain `Uint8Array` pays one
extra scan, about 9% of its encode time. One that carries a `Float32Array` takes
about twice as long to encode, and in exchange it now carries the right bytes. Class instances and types an app encodes with its own
msgpackr `addExtension` are left alone.

### Reading a typed array back

A TCP or SQLite reader gets a `Uint8Array`, because MessagePack has no type for
"array of floats". To turn it back into numbers, copy the bytes into a new
`Uint8Array` first: a decoded view can start at any offset of a shared buffer, and
a `Float32Array` over that buffer rejects an unaligned offset.

```ts
const bytes = job.data.vector as Uint8Array;
const vector = new Float32Array(new Uint8Array(bytes).buffer); // [1.5, 2.5]
```

Rows stored with corrupt bytes before this release are not repaired. The
TypeScript SDK (`bunqueue-client`) gets the same fix in its next release: it
currently refuses these views with `SerializationError`.

### What we did not ship

msgpackr 2.1.3 is out, so we tested whether upgrading would fix the bug for free.
It does not: 2.1.3 still copies TypedArrays element by element. It also changes
how the subclasses of a few built-in types (Error, Set, RegExp, ArrayBuffer,
TypedArray) that define their own `toJSON` are encoded, which would change what
some jobs store. For example, an HTTP client error whose `toJSON` includes request
headers would start persisting them. It also showed no consistent throughput gain in our
A/B runs. bunqueue stays on msgpackr 1.x until those changes can be handled
deliberately.

## Other improvements

- **Benchmark against BullMQ.** A new [Benchmark vs BullMQ](/guide/bullmq-benchmark/)
  page compares bunqueue 2.9.20 with BullMQ 6.4.2 on Redis 8.10.2, in memory and on
  disk. The machine was bare-metal Debian 13 on an AMD Ryzen 9 7950X3D, and every
  number is the median of five runs with its range. Both wins and losses are
  reported:
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

- **Embedded `getDelayedCount()` counts every delayed job.** It counted one default
  `getJobs` page, so it never reported more than 100: a queue with 250 delayed jobs
  answered 100. It now uses the same counts as `getJobCounts()`, as over TCP.
- **Simple Mode processors see the Worker's aborts.** A `Bunqueue` processor kept
  running after its job had ended elsewhere, because the wrapper dropped the
  Worker's signal. That happened on a server-enforced `timeout`,
  `app.worker.cancelJob(id)`, `cancelAllJobs()` and a forced worker close. Now
  `app.getSignal(job.id)` is aborted with the Worker's reason, and any pending
  in-process retry stops. A processor that honours the abort counts it as a failure
  for the circuit breaker, as `app.cancel()` already did, so cancelling many
  running jobs with `cancelAllJobs()` can now open the circuit.

## How these numbers were measured

The throughput figures were measured on native macOS 27.2 on an Apple M5 Max
(18 cores, 64 GB), with Bun 1.4.4 and the final 2.9.21 code.

- **Baseline:** the v2.9.20 column is commit `588fccb8`, which is v2.9.20 plus a
  documentation-only change.
- **Samples:** each sample used a fresh server, database and ports. Each row is the
  median of six samples in an order that rotated every round, or of the ABBA
  samples where a table says so.
- **Workers:** `concurrency: 50`, `batchSize: 20` and `heartbeatInterval: 5000`.
- **Clients:** `pingInterval: 0`; the producer used a pool of 8 connections.
- **Socket reads and call counts:** one instrumented run per scenario. The
  instrumentation slows the code down, so those runs are used for counts, never for
  throughput.
- **Stability:** 24 runs of 2.9.21, in embedded and TCP, memory and SQLite, with
  one and four worker processes, at 1,000, 10,000, 100,000 and 1,000,000 jobs.
  Every run delivered each job exactly once and left an empty queue with no
  errors.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.20](/blog/bunqueue-v2-9-20/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.21) · [Commits since v2.9.20](https://github.com/egeominotti/bunqueue/compare/v2.9.20...v2.9.21) · [Full changelog](/changelog/) · [All posts](/blog/)
