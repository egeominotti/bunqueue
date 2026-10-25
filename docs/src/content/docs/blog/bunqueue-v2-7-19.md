---
title: "bunqueue v2.7.19"
description: "Fixes 13 bugs. Cloud snapshots leaked unredacted job data (security): BUNQUEUE_CLOUD_REDACT_FIELDS was applied only to the event stream, never to periodic snapshots, so raw job.data and DLQ jobData (potential PII/secrets) were sent to the…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-19.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.19</em></h1>
  <p class="bq-hero-sub">Fixes 13 bugs. Cloud snapshots leaked unredacted job data (security): BUNQUEUE_CLOUD_REDACT_FIELDS was applied only to the event stream, never to periodic snapshots, so raw job.data and DLQ jobData (potential PII/secrets) were sent to the…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.19

```bash title="bun"
bun add bunqueue@2.7.19
```

```bash title="npm"
npm install bunqueue@2.7.19
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

Happy-path behaviour was already solid; these harden bunqueue under failure, stress, attack, restart and long-running conditions. Each fix ships with a `test/audit-*.test.ts` that reproduced the bug (red) and now passes (green).

- **Cloud snapshots leaked unredacted job data (security)**: `BUNQUEUE_CLOUD_REDACT_FIELDS` was applied only to the event stream, never to periodic snapshots, so raw `job.data` and DLQ `jobData` (potential PII/secrets) were sent to the dashboard. Redaction (and `includeJobData` gating) is now threaded through the snapshot path via a shared `redact` helper. (`cloud/snapshotHelpers.ts`, `snapshotCollector.ts`, `cloudAgent.ts`, new `cloud/redact.ts`)
- **WriteBuffer critical loss was unrecoverable after restart**: when a flush exhausted its 10 retries, lost jobs were only logged + kept in an in-memory cap; they are now persisted to the DLQ (direct DB write, no recursion into the failed buffer) so they survive a restart. (`persistence/sqlite.ts`)
- **Corrupt `dependsOn` blob ran jobs out of order**: a MessagePack decode failure silently returned empty deps, so a job recovered with corrupt dependency metadata executed as if it had none. Corruption is now flagged with a collision-proof `Symbol` and the job is routed to the DLQ on recovery instead of running. (`persistence/sqliteSerializer.ts`, `application/backgroundTasks.ts`)
- **Worker ACK batcher silently dropped ACKs on overflow**: at the pending-ACK cap the oldest ~10% were discarded without being sent, leaving those jobs stuck `processing` and requeued indefinitely. Overflow now applies backpressure (awaits a flush) instead of dropping. (`worker/ackBatcher.ts`)
- **TCP slowloris / per-connection memory exhaustion**: a partial frame had no read timeout. A per-connection stall timer (armed only while a partial frame is buffered, `TCP_IDLE_TIMEOUT_MS`, default 60s) now reaps stalled connections; single frames remain bounded by `maxFrameSize`. Legitimate 4–64MB frames delivered across TCP segments are unaffected. (`server/protocol.ts`, `server/tcp.ts`)
- **TCP responses dropped under backpressure**: `socket.write()` short-writes were ignored and `drain()` was a no-op. A per-socket write queue now buffers unwritten bytes (order-preserving), flushes on `drain()`, and caps at `TCP_MAX_WRITE_QUEUE_BYTES` (default 64MB, drops the connection past the cap). (`server/tcp.ts`, new `server/socketWriteQueue.ts`)
- **TCP client hung on a malformed frame (pipelining)**: only the legacy `currentCommand` was rejected; all in-flight pipelined commands hung until timeout. A malformed frame now rejects every in-flight command and force-reconnects. (`client/tcp/client.ts`)
- **Flow-failure tracking maps grew unbounded**: `failedChildrenValues`/`ignoredChildrenFailures` were never cleared on normal parent completion or in `shutdown()` (only on `obliterate`). They are now released when the parent reaches a terminal state and cleared on shutdown. (`application/queueManager.ts`)
- **`forEach` saga compensation lost iteration context**: compensate handlers couldn't tell which item they were rolling back (`__item`/`__index` weren't restored). Each iteration's item/index is now persisted on its step record and restored into the compensation context. (`workflow/loops.ts`, `compensator.ts`, `types.ts`)
- **Re-created cron silently skipped its first fire**: `lastFiredAt` wasn't cleared on `remove()`/upsert, so a same-named cron hit stale overlap detection. It is now cleared on remove/upsert. (`scheduler/cronScheduler.ts`)
- **Interval cron drift**: `repeatEvery` `nextRun` was computed from execution time (`now + interval`), drifting on late runs; it is now anchored to the scheduled slot (fixed-rate). (`scheduler/cronScheduler.ts`)
- **S3 restore could corrupt/delete the live DB**: restore wrote over the live database before validating, and a failed integrity check unlinked it. Restore is now atomic: write to temp → validate → rename; the live DB is never touched on failure. (`backup/s3BackupOperations.ts`)
- **DLQ exceeded `maxEntries` after restart**: `restoreEntry()` skipped the eviction `add()` performs; it now enforces `maxEntries` (oldest-first) on recovery. (`domain/queue/dlqShard.ts`)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.18](/blog/bunqueue-v2-7-18/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.19) · [Commits since v2.7.18](https://github.com/egeominotti/bunqueue/compare/v2.7.18...v2.7.19) · [Full changelog](/changelog/) · [All posts](/blog/)
