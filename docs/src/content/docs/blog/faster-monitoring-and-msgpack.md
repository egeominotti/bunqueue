---
title: "Faster Monitoring and MessagePack, With the Same Compatibility Boundaries"
description: "A measured look at two bunqueue optimizations: less repeated monitoring work, faster MessagePack scanning, and a SQLite batching experiment we rejected."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/faster-monitoring-and-msgpack.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-11-15"
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · engineering</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Less repeated work. The same compatibility <em>boundaries.</em></h1>
  <p class="bq-hero-sub">Two focused source changes reduce monitoring overhead and MessagePack decoding cost. The measurements also show where the gains stop, and why a promising SQLite experiment stayed out.</p>
</div>

Performance work in a queue has two obligations: reduce the cost of an operation and preserve what callers can observe. A faster success path is only part of the evidence. Event callbacks, payload handling, partial failures, and recovery still matter.

This campaign retained two small optimizations. A monitoring pass now avoids repeatedly counting the same active jobs, and MessagePack decoding uses a native byte search for its prototype-key check. A third experiment, grouping durable SQLite admissions into a transaction, was rejected after compatibility failures.

These are **unreleased source changes**, not a new package release. The figures below describe narrowly scoped engineering measurements on one machine.

## Monitoring: count once, reuse carefully

Queue-idle monitoring needs the active-job count for each queue. Previously, it scanned every processing shard for every queue. With many queues and many active jobs, the same entries were visited repeatedly.

The retained change builds a map of active counts during a pass and reuses it across queues. The single-queue path keeps its direct scan. Disabled idle monitoring still returns before collecting counts.

There is a subtle condition: event handlers run synchronously. An idle callback can change the processing maps or the queues visited next. Reusing a snapshot after that callback could change a later idle decision. The implementation invalidates the count map after emitting an idle event, so a subsequent queue sees live state again.

The repeated native measurements show the effect on the measured pass:

| Workload | Baseline median | Candidate median | Ratio |
| --- | ---: | ---: | ---: |
| 100 queues, 10,000 active jobs | 2.284235 ms | 0.090535 ms | 25.23× faster |
| 1,000 queues, 100,000 active jobs | 502.040724 ms | 1.560187 ms | 321.78× faster |

These ratios apply to a monitoring pass over prepared in-memory state. They are not multipliers for job throughput. The timed monitoring workloads emitted no events; a separate correctness oracle checked exact events, inclusive waiting boundaries, disabled behavior, and synchronous callback mutations.

The small control is useful too. With one queue, the median rose from about 0.169 to 0.193 microseconds per check: roughly 24 nanoseconds, or 14.29%. That is a measurable trade-off in this control. The disabled-path difference was too small to support a performance claim.

## MessagePack: move the byte search into the runtime

Before decoding, bunqueue checks whether a MessagePack frame contains the bytes for `__proto__`. Frames containing that sequence take the existing safe conversion path, which preserves an own property without changing the decoded object's prototype.

The old check walked the frame in JavaScript. The new check creates a `Buffer` view over the exact input range and calls `indexOf`. The view shares the existing bytes; its offset and length keep adjacent bytes outside a sliced input out of the search. The safe conversion path remains in place.

For 2,000 decodes of a frame carrying a 64 KiB text payload, the median fell from **186.146666 ms to 9.827125 ms**, an 18.94× ratio. A 1 MiB payload also improved in its separate decoder scenario. Small frames and the explicit prototype-key control showed little change.

That large decoder ratio does not predict a matching end-to-end gain. A broker still handles commands, transports bytes, manages queue state, and sends responses. We measured that boundary separately.

## The TCP result: a smaller, practical improvement

The TCP harness started a fresh broker process with memory-only storage for each sample. It sent 2,000 scalar `PUSH` commands, then performed scalar `PULL`/`ACK` pairs. There was no client auto-batching and no SQLite persistence in this measurement.

With 64 KiB payloads, the whole timed sequence dropped from **455.990833 ms to 399.550833 ms**: **12.38% less time**, or **1.141× the completion rate**. This is the relevant transport-level result for that workload. With 32-byte payloads, the distributions overlapped and the median difference was inconclusive.

Every TCP sample reconciled accepted and delivered IDs, order, payload checksums, completion counts, empty final queues, and lifecycle counters. Those checks keep a faster incomplete run from becoming a reported improvement.

## Why SQLite batching stayed out

Grouping durable inserts looked attractive because fewer transaction boundaries can reduce storage overhead. But the existing scalar admission path persists each job before publishing it and moving to the next input. Earlier successes therefore form a durable prefix when a later input fails.

The prototype moved that boundary. In one injected COMMIT/ROLLBACK failure scenario, the baseline retained one job in memory and on disk; the prototype exposed one in memory but recovered zero. Payload accessors and proxies also observed different intermediate state because preparation happened earlier.

Process-kill experiments made the boundary visible: after the first insert, the scalar baseline recovered one row and the grouped prototype recovered zero. After a successful grouped commit or public return, the prototype recovered all three rows. The finding concerns the moved intermediate boundary; it does not show normal post-return loss.

We rejected this prototype under the compatibility requirements. SQLite admission remains unchanged, and this work claims no SQLite speedup.

## What the evidence supports

Measurements ran serially on native macOS, on an Apple M5 Max with 18 logical CPUs and 64 GiB RAM, using Bun 1.4.4. Each variant and scenario had one discarded fresh-process warm-up and seven fresh-process measurements, alternating baseline/candidate order. The campaign retained 140 measurements and discarded 20 warm-ups.

Functional validation was separate: the recorded product sandbox had zero failures, as did the SDK sandbox, fresh Ubuntu Machine gate, and isolated model campaign. The 1,558 protected test, fixture, and runner files remained byte-identical. These checks provide regression evidence, not a blanket stability guarantee, and overlapping platform suites are not additive unique tests.

The [technical report](https://github.com/egeominotti/bunqueue/blob/main/docs/benchmarks/performance-stability-2026-11-15.md) includes ranges, coefficients of variation, controls, and validation receipts. The [raw samples](/benchmarks/performance/2026-11-15/samples.json), [full-precision summaries](/benchmarks/performance/2026-11-15/summaries.json), and [manifest with reproduction details](/benchmarks/performance/2026-11-15/manifest.json) make the arithmetic inspectable. These workloads establish targeted cost reductions; they do not establish production latency percentiles, durable throughput, or deployment capacity.
