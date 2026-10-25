---
title: "bunqueue v2.9.1"
description: "Fixes 6 bugs. Multi-broker correctness fix."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-28"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.1</em></h1>
  <p class="bq-hero-sub">Fixes 6 bugs. Multi-broker correctness fix.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

> **Multi-broker correctness fix.** PostgreSQL readers no longer keep a stale
> queue view when event retention removes history they have not consumed. The
> schema version becomes 18, so upgrade every broker in a cluster together: a
> 2.9.0 broker started against an upgraded database fails with
> `PostgreSQL schema version 18 is newer than supported version 17`.

## Changes

- The PostgreSQL schema version is now 18. The migration adds
  `self_pruned_commit_seq` and replaces the `bunqueue_assign_event_commit`
  commit-sequencer function; both are applied automatically on the first
  connection, with no manual step. Because the fix depends on that shared
  trigger, **upgrade every broker in a cluster**: a 2.9.0 broker pointed at an
  upgraded database now refuses to start with
  `PostgreSQL schema version 18 is newer than supported version 17` instead of
  rewriting the trigger back and silently disabling the fix for every broker.

## Bugfixes

- PostgreSQL multi-broker: a broker could keep a stale queue read model after
  retention pruned events it had not consumed. Two paths did it. A transaction
  that writes more queue events than `maxQueueEvents` prunes its own older
  events before any other broker can observe them, so a reader that applied only
  the retained tail of that commit kept the pruned jobs in their previous state,
  permanently once a later checkpoint superseded the pruning one. And a drain
  that applied a batch without re-checking retention could miss history a newer
  commit had pruned. A prune watermark is now treated as covered only when the
  applied commit cursor is strictly ahead of the pruned frontier;
  `bunqueue_event_prune_watermarks` carries a cumulative, per-queue
  `self_pruned_commit_seq` that every later watermark inherits, so a
  self-pruning commit forces one authoritative refresh per broker; and a drain
  that loaded journal entries always re-scans watermarks against its pre-batch
  position before applying them. The new `postgres/eventCatchupCursors.ts` owns
  the per-queue bookkeeping and remembers the frontier already handled, so a
  stable frontier does not reload the queue on every poll: a reader strictly
  ahead of the pruned frontier makes no extra refresh at all, while a lagging
  reader still reloads once per new frontier.
  (`test/postgres-event-partial-commit-retention.test.ts`)

## Bugfixes

- The soak test's latency-drift check no longer trips on a noisy CI runner. Its
  per-tick statistic is the maximum of 40 probe pushes, so a noisy neighbour
  elevated most windows of one half and shifted even that statistic's median
  (18ms to 96ms on GitHub Actions, while every conservation, memory and WAL
  assertion held). Drift from a bloating internal structure moves the typical
  latency, not just the tail, so the ratio test now runs on per-tick medians and
  the tail keeps an absolute ceiling.
- The extreme PostgreSQL public-API suite no longer fails when a shared CI
  runner starves it. Its client command bound was 15s while four brokers, one
  PostgreSQL and the test process compete for the same cores; a saturated run
  hit that bound and reported a timeout instead of the exactly-once property the
  suite exists to check. The bound is now 45s, with the per-job and per-test
  waits raised to match. Measured on a CPU-limited PostgreSQL 16: 3 failures in
  10 runs before, 0 in 6 after.
- Test helpers no longer drop stream output while waiting. Racing
  `reader.read()` against a timer leaves the pending read queued, so the chunk
  it later receives is discarded and a slow producer looks like a silent one —
  which is why a spawned server that did print its banner was reported as
  producing nothing. (`test/stream-reader.test.ts`)
- The local CLI end-to-end test no longer reports an empty stdout when the
  server it spawns loses the race for its reserved ports. It reads stderr too,
  retries a confirmed bind collision, and waits long enough for a loaded CI
  runner to finish booting.
  (`test/cli-invariants-local-e2e.test.ts`)
- The multi-process PostgreSQL topology harness now retries broker startup when
  it loses the race for its probed TCP/HTTP port pair, instead of failing the
  suite with `Is port <n> in use?`. The probe sockets are released before the
  broker binds them, so a concurrent worker could win that window.
  (`test/postgres-process-port-conflict.test.ts`)

## Thanks to 2 contributors!

- [@egeominotti](https://github.com/egeominotti)
- [@mikemikimike](https://github.com/mikemikimike)

---

[← bunqueue v2.9.0](/blog/bunqueue-v2-9-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.1) · [Commits since v2.8.61](https://github.com/egeominotti/bunqueue/compare/v2.8.61...v2.9.1) · [Full changelog](/changelog/) · [All posts](/blog/)
