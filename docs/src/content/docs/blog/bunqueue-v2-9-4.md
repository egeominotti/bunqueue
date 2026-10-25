---
title: "bunqueue v2.9.4"
description: "Deep-profiled queue hot paths and TCP ACK latency."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-4.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-09-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.4</em></h1>
  <p class="bq-hero-sub">Deep-profiled queue hot paths and TCP ACK latency.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

> **Deep-profiled queue hot paths and TCP ACK latency.** This change set removes
> the quadratic completion-evidence eviction path, stops the in-memory telemetry
> journal from retaining event payload graphs, reuses SQLite telemetry statements
> and exact retention counts, and prevents low-concurrency TCP workers from waiting
> for the 50 ms ACK fallback on every completion wave. The implementation was
> driven by Bun 1.4.0 CPU and heap profiles and preserves the existing wire format,
> persistence schema, scheduling rules, and public configuration defaults.

#### To install bunqueue v2.9.4

```bash title="bun"
bun add bunqueue@2.9.4
```

```bash title="npm"
npm install bunqueue@2.9.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## TCP ACK correctness and compatibility

| Contract                | Evidence preserved by the implementation                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire compatibility      | `ACKB`, request/response framing, MessagePack encoding, lock tokens, result ordering, and retry commands are unchanged.                                                   |
| Configured batch size   | The reachable frontier is a ceiling only: the effective threshold can shrink but never exceeds `batchSize`.                                                               |
| Native batch processing | A sealed native batch contributes its exact started members, so full and partial batches coalesce without using the configured maximum as a guess.                        |
| Scalar buffer           | Only current deliveries that can start within concurrency, rate, and simulated per-group capacity contribute to the pending threshold.                                    |
| Outcome phases          | A delivery generation moves atomically from unqueued to pending; failure/manual transitions retire it, and ACKs already assigned to a flush cannot inflate a later batch. |
| Dynamic controls        | Concurrency reduction, pause, runtime rate limiting, and close immediately re-evaluate pending ACKs against the reduced frontier.                                         |
| Failure handling        | In-flight flushes remain tracked, retry limits and delays are unchanged, and `close()` continues to await pending/in-flight acknowledgements.                             |
| Embedded workers        | Embedded ACKs remain direct and do not use the TCP-only capacity ceiling.                                                                                                 |
| Half-open recovery      | Workers continue to surface transient transport errors through the required `error` listener while the connection health path reconnects and resumes throughput.          |

## Optimization summary

| Area                       | Previous hot-path cost                                                                                                                                       | Optimization                                                                                                                                              | Resulting behavior                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TCP Worker ACK batching    | A worker could wait for the 50 ms fallback whenever configured capacity exceeded the outcomes that could actually reach the pending batch.                   | Track an event-driven frontier of pending ACKs, unqueued started generations, and immediately startable scalar buffer entries, capped by `batchSize`.     | Full waves still coalesce, while partial/final/native-batch/rate- or group-limited cohorts flush as soon as every reachable outcome is buffered.                                     |
| Completion evidence        | Once the recent-completion cap was full, repeatedly restarting a `Set` iterator over deleted historical slots made sustained eviction effectively quadratic. | Track recent completion order with a head index and per-occurrence tokens, with bounded stale-slot compaction.                                            | Exact one-at-a-time FIFO eviction is amortized O(1), including delete, pin, unpin, hydration, clear, and same-ID reuse paths.                                                        |
| In-memory event retention  | Every retained lifecycle event kept its payload object graph alive and front-spliced arrays during trimming.                                                 | Retain only an exact per-queue event count; subscribers still receive the original synchronous event stream.                                              | `trimEvents()` keeps its count/removal contract without retaining payloads, and empty-queue cleanup releases the count while preserving cumulative metrics.                          |
| SQLite telemetry setup     | Scalar telemetry writes repeatedly prepared the same SQL and executed retention SQL even before a queue reached its cap.                                     | Introduce a storage-lifetime telemetry store with cached statements, reusable transactions, and exact committed event counts.                             | Retention deletes run only on overflow, remove exactly the excess oldest rows, and zero event retention skips journal inserts while terminal metrics remain active.                  |
| SQLite telemetry lifecycle | Trim, clear, and queue deletion could invalidate any cached retention knowledge.                                                                             | Refresh counts after explicit trim/count operations and invalidate them after clear or queue destruction, only after the surrounding transaction commits. | Cached counts remain aligned with durable rows across restart, trim, clear, obliterate, rollback, and later reuse of the same queue name.                                            |
| Profiling workflow         | CPU time, JavaScript retention, native allocator high-water, and profiled wall time could be conflated.                                                      | Document separate native baseline, CPU, V8 heap, Markdown heap, forced-GC, Bun JSC, process-memory, queue-memory, and mimalloc evidence.                  | Future investigations can distinguish CPU self/total time, retained JS objects, and native allocator behavior without treating profiled timing or RSS alone as benchmark/leak proof. |

## Native performance evidence

All timings below were collected natively on an Apple M1 Max running Bun 1.4.0.
Benchmark samples used fresh processes and state; profiled runs were used only for
attribution. Results describe these workloads, not a universal throughput
guarantee.

| Workload                                                     |                                     Before |                                    After |                                     Improvement |
| ------------------------------------------------------------ | -----------------------------------------: | ---------------------------------------: | ----------------------------------------------: |
| TCP Worker, 60 trivial jobs, `concurrency=1`, `batchSize=10` |               19.2795 jobs/s; 3,112.113 ms |             2,710.8484 jobs/s; 22.133 ms |    140.61x throughput; 99.29% less elapsed time |
| One-million-job in-memory completion phase                   |                                  46,356 ms |                                 2,691 ms |                   94.2% less time; 17.2x faster |
| One-million-job full in-memory lifecycle                     |                   48,949 ms; 20,429 jobs/s |                 4,335 ms; 230,681 jobs/s |               91.1% less time; 11.3x throughput |
| Completion-tracker churn, 300,000 IDs with a 50,000 cap      |                               8,418.918 ms |                                94.179 ms |                                    89.4x faster |
| In-memory event workload, 180,000 events across 20 queues    | 17,746,708 retained bytes; 263,580 objects | 3,201,858 retained bytes; 23,649 objects | 82.0% fewer retained bytes; 91.0% fewer objects |
| SQLite scalar lifecycle, 3,000 push/pull/ACK operations      |                                2,788.07 ms |                              1,549.35 ms |                           44.4% less total time |

The final event-driven frontier's five-process median was 2,710.8484 jobs/s;
the clean baseline's three-process median was 19.2795 jobs/s. A fresh 1,000-job
capacity matrix produced exact `ACKB` widths of 1, 2, 4, and 10 at the matching
worker concurrency; a configured width of 2 remained 2 at concurrency 4,
confirming that the frontier does not enlarge user-configured batches.

The SQLite telemetry work also improved representative workflow throughput while
leaving workflow state transitions unchanged:

| Workflow scenario | Embedded before | Embedded after | TCP before |     TCP after |
| ----------------- | --------------: | -------------: | ---------: | ------------: |
| Linear            |           298/s | 399/s (+33.9%) |      531/s | 565/s (+6.4%) |
| Parallel          |           275/s | 338/s (+22.9%) |      430/s | 464/s (+7.9%) |
| Compensation      |           259/s | 314/s (+21.2%) |      434/s | 441/s (+1.6%) |
| Signal            |           238/s | 284/s (+19.3%) |      427/s | 439/s (+2.8%) |

## Telemetry and completion invariants

| Invariant                                                             | Regression coverage                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Recent completion evidence evicts in exact FIFO order                 | Covers cap overflow plus pin, delete, re-add, unpin, hydrate, clear, and queue-owner deletion.                              |
| A stale order slot cannot evict a newer occurrence of the same job ID | Per-occurrence tokens are checked before eviction and rewritten during compaction.                                          |
| Event retention never exceeds the configured SQLite cap               | Counts are loaded at startup, inserts are counted transactionally, and only the precise overflow is deleted oldest-first.   |
| Failed SQLite writes cannot advance the cache                         | Count updates are applied only after the database transaction returns successfully.                                         |
| Explicit trim, telemetry clear, and queue deletion remain exact       | Each path refreshes or invalidates its count and is exercised across subsequent writes.                                     |
| `maxQueueEvents=0` does not disable terminal metrics                  | Event rows are skipped, while completed/failed metric grouping and cumulative metadata still run.                           |
| Empty-queue cleanup does not erase cumulative metrics                 | Only the transient in-memory retention count is released; `obliterate` remains the operation that clears telemetry history. |

## Validation

| Gate                                                     | Result                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Full disposable-container sandbox                        | Passed: 8,564 unit tests, 69/69 TCP suites with 499 assertions, and 43/43 embedded suites with 342 tests; zero failures. |
| Asynchronous lifecycle command model                     | Passed: 11 tests and 84,144 assertions against a real TCP broker and SQLite.                                             |
| Repeated new TCP ACK regressions                         | Passed: 200/200 across 20 repetitions of all ten frontier scenarios.                                                     |
| Focused Worker, ACK, durability, and half-open campaigns | Passed: 107/107 with no job loss, duplicate ACK, ordering error, or unrecovered connection.                              |
| Static verification                                      | TypeScript typecheck, Oxlint/Oxfmt project checks, and `git diff --check` passed.                                        |

The final parallel sandbox ran on Bun 1.4.0 in three disposable, network-isolated
containers and reported no resource anomalies:

| Suite    | Duration |  Peak RAM |   Start -> end RAM |    CPU avg / p95 / peak | PID peak | Runner verdict |
| -------- | -------: | --------: | -----------------: | ----------------------: | -------: | -------------- |
| Unit     | 7.96 min |  1.83 GiB | 201.0 -> 272.9 MiB | 65.3% / 230.3% / 692.5% |      132 | No anomalies   |
| TCP      | 8.99 min | 166.1 MiB |  99.7 -> 134.3 MiB |    9.1% / 26.8% / 71.8% |       61 | No anomalies   |
| Embedded | 4.11 min |  42.8 MiB |   27.3 -> 42.7 MiB |    4.1% / 19.2% / 36.0% |       40 | No anomalies   |

Container resource growth is still only an investigation signal, not proof of a
JavaScript leak. Focused forced-GC heap profiles independently showed that the
event-payload graph was removed and did not show retained JavaScript growth;
peak RSS remains tracked separately from heap retention.

## Deliberately deferred

Deep profiling also identified further opportunities, but they are not part of
this change set and their behavior is unchanged:

| Candidate                                     | Observed cost                                                                                                         | Why it remains separate                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Atomic `removeOnComplete` completion evidence | Durable removal remained roughly 4.2-4.7x more expensive than retaining completed jobs in the isolated ACK benchmark. | Requires a new bounded multi-row transaction while preserving pin, sequence, pruning, rollback, and crash-recovery semantics. |
| Further SQLite telemetry coalescing           | Disabling telemetry still materially reduces scalar persistence time after statement caching.                         | Changes write timing/durability and needs an explicit shutdown and failure contract.                                          |
| Immediate temporal-index removal              | A one-million-job run retained temporal entries until background cleanup even though jobs had completed.              | Must update dequeue, retry, terminal, and recovery invariants together.                                                       |
| Narrow `WorkflowStore.update()` writes        | Full workflow persistence remained the largest workflow-specific SQLite caller.                                       | Requires state-specific patches without changing signal, compensation, or recovery ordering.                                  |
| Ordered job views and maintained counters     | `getJobs()`, `getStats()`, and queue summaries still scale with total in-memory cardinality.                          | Every lifecycle transition must update new views/counters exactly once and remain model-checked.                              |
| MessagePack replacement                       | `msgpackr` was measurable on the TCP client but was not the dominant broker or persistence cost.                      | A replacement must preserve or version the wire format and be benchmarked independently on client and broker.                 |

## Regression tests added

- Added real TCP protocol coverage for low-concurrency ACK flushing, concurrent
  coalescing, final scalar cohorts, runtime concurrency reduction, full and
  partial native batches, rate-limited admission, group-blocked and independent
  groups, and mixed successful/failed native-batch members.
- Added hot-path regression coverage that rejects `Set` iterator restarts during
  completion eviction and proves FIFO behavior across every stale-slot path.
- Added SQLite regression coverage proving storage-lifetime statement reuse and
  exact cached counts across restart, overflow, trim, clear, queue deletion, and
  reuse.
- Added an in-memory cleanup regression proving that transient event retention is
  released without deleting completed metrics.
- Hardened the half-open Worker recovery test with the required EventEmitter
  `error` listener now that ACKs can expose the expected transient timeout before
  reconnection more quickly.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.3](/blog/bunqueue-v2-9-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.4) · [Commits since v2.9.3](https://github.com/egeominotti/bunqueue/compare/v2.9.3...v2.9.4) · [Full changelog](/changelog/) · [All posts](/blog/)
