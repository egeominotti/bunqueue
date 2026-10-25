---
title: "bunqueue v2.9.2"
description: "Ships 4 performance improvements and 2 additions. Reworked the main Examples page into an explicit beginner-to-advanced path: one embedded job, lifecycle and reliability, process boundaries, workflows, and finally the tested PostgreSQL…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.2</em></h1>
  <p class="bq-hero-sub">Ships 4 performance improvements and 2 additions. Reworked the main Examples page into an explicit beginner-to-advanced path: one embedded job, lifecycle and reliability, process boundaries, workflows, and finally the tested PostgreSQL…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.2

```bash title="bun"
bun add bunqueue@2.9.2
```

```bash title="npm"
npm install bunqueue@2.9.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Reworked the main Examples page into an explicit beginner-to-advanced path:
  one embedded job, lifecycle and reliability, process boundaries, workflows,
  and finally the tested PostgreSQL multi-broker project. Existing section
  anchors remain stable. New progressively enhanced diagrams let readers step
  through success, retry, and DLQ transitions or compare embedded, TCP broker,
  and PostgreSQL multi-broker topologies. The controls are keyboard accessible,
  announce state changes, respect reduced motion, and retain a useful
  server-rendered first state. Pure explainer models and documentation
  regressions verify the reading order, local anchor targets, state boundaries,
  topology progression, accessibility hooks, and project file-size limit.
- Added a complete PostgreSQL multi-broker Examples section backed by an
  executable project rather than copied snippets. Its disposable Docker
  topology runs PostgreSQL 18.6, three uniquely identified brokers, an internal
  runtime network, authenticated TCP/metrics, readiness gates, and a separate
  SDK image built from the current public package source. Four asserted
  scenarios cover broker health, multiple queues/workers, bulk admission,
  behaviorally asserted priority and delayed ineligibility/promotion, retry,
  progress, logs, events, worker discovery, concurrent custom-ID idempotency,
  shared pause, a cross-broker single-slot concurrency handoff, fixed-window
  rate-budget exhaustion/removal, DLQ recovery, and a three-level cross-queue
  `FlowProducer` graph. The runner rejects prototype-chain scenario names, is
  import-safe, lazily loads only the selected scenario, and bounds HTTP
  requests, polling predicates, and scenarios.
  Multi-phase application cleanup captures synchronous and asynchronous errors
  without skipping later phases. The verifier validates destructive project
  overrides, registers cleanup before infrastructure creation, independently
  attempts resource and image removal, and preserves the original failure
  status. A real forced-timeout campaign and focused fake-Docker regressions
  prove those failure paths. The new docs
  include topology, SDK, reliability, flows, N-broker operations, and a dated
  engineering validation report; rendered code is imported from the exact
  tested files to prevent documentation drift. The documentation data guard now
  resolves Vite query and fragment suffixes before checking those source files,
  preserving its clean-checkout and tracked-file guarantees for `?raw` imports.
  The full LLM documentation dump expands the same imports into real fenced
  source instead of leaking unresolved MDX variables, while the curated
  `llms.txt` links the new example hub directly. Documentation builds now end
  with a discovery validator that compares `llms-full.txt` and the sitemap with
  the content tree, verifies all imported example sources, checks curated links
  and ordering, and confirms the robots discovery pointers. The sanitized unit
  image and its explicit context allowlist include the full-text transformer
  and executable example, keeping both regression suites inside the mandatory
  isolated repository gate without widening the context to unrelated examples.

## Performance

- PostgreSQL notification-driven event retention now uses a non-blocking
  per-queue advisory-lock attempt instead of occupying a pool connection behind
  an in-flight writer for up to the configured lock timeout (5 seconds by
  default). Contended sweeps coalesce into one retry capped at 250 ms, removing
  lock convoys from high-contention multi-broker bursts and letting the retained
  event window converge promptly. Manual trim and crash recovery remain
  blocking and exact; expected contention stays healthy, and shutdown cancels
  the pending retry.
- SQLite lifecycle telemetry now batches `PUSHB`, `PULLB`, and `ACKB` journal
  writes in one transaction. Events retain their input order, journal retention
  runs once per affected queue, and completed/failed metric mutations are
  aggregated per queue/type after simulating scalar pruning exactly. Ordinary
  subscribers, completion waiters, and webhooks still receive every event; a
  failed batch rolls back and retries per event so one rejected row does not
  suppress later telemetry. A deterministic differential suite covers mixed
  queues, terminal and retry-attempt failures, zero through bounded retention,
  and out-of-order timestamps. On native macOS arm64 with Bun 1.4.0, the new
  diagnostic runner's five-run median for 5,000 durable jobs improved from
  5,310.42ms (941.55 jobs/s) to 1,689.22ms (2,959.95 jobs/s), a 3.14x complete
  push/pull/ack lifecycle gain. Per-phase medians improved 2.08x for push, 3.31x
  for pull, and 4.08x for ack. These host results are diagnostic before/after
  evidence, not publication benchmarks.
- SQLite `PULLB` and retained, result-free `ACKB` now persist active/completed
  state with one transaction per operation instead of one commit per job.
  Buffered inserts are flushed first, timelines are encoded outside the
  transaction, and any rejected row rolls the batch back before scalar retry;
  result-bearing and `removeOnComplete` batches keep their existing ordering.
  Differential tests compare raw rows with scalar writes and cover buffered
  jobs, atomic rollback, public routing, and both fallback paths. Using the same
  native macOS arm64/Bun 1.4.0 runner for 5,000 durable jobs, the five-run
  median improved from 1,784.47ms (2,801.95 jobs/s) to 932.63ms (5,361.18
  jobs/s), a further 1.91x complete-lifecycle gain. Pull improved from 529.45ms
  to 153.89ms (3.44x) and ack from 613.98ms to 176.81ms (3.47x); push remained
  outside the change at 627.75ms versus 602.62ms. These are diagnostic
  before/after results, not publication benchmarks.
- A final native A-B-B-A comparison ran the clean preceding Git revision and
  the complete candidate in alternating fresh processes. Across 10 measured
  fresh-database samples per version, the pooled median for the same 5,000-job
  durable lifecycle fell from 5,195.99ms to 911.90ms (5.70x), while
  median-derived throughput rose from 962.28 to 5,483.06 jobs/s. The
  candidate's slowest sample was still 5.44x faster than the preceding
  revision's fastest sample. Exact raw results and methodology are retained in
  the local validation artifacts; this remains diagnostic host evidence.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.1](/blog/bunqueue-v2-9-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.2) · [Commits since v2.9.1](https://github.com/egeominotti/bunqueue/compare/v2.9.1...v2.9.2) · [Full changelog](/changelog/) · [All posts](/blog/)
