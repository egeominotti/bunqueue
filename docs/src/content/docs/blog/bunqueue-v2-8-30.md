---
title: "bunqueue v2.8.30"
description: "Protocol fuzzing, chaos / fault injection, race / concurrency, crash-recovery and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-30.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.30</em></h1>
  <p class="bq-hero-sub">Protocol fuzzing, chaos / fault injection, race / concurrency, crash-recovery and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.30

```bash title="bun"
bun add bunqueue@2.8.30
```

```bash title="npm"
npm install bunqueue@2.8.30
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

Eight new adversarial test suites under `test/repro-*.test.ts` assert the delivery and resource guarantees a continuously-running deployment depends on. Each drives a real `QueueManager` + TCP server (several spawn the real `src/main.ts` process against on-disk SQLite) and asserts hard invariants, not just "it ran". Result: **50 tests / ~34.6k assertions, all green**, and no product bug surfaced (the guarantees already hold).

Documented in `docs/architecture.md` (new _Reliability & Battle-Testing_ section). No runtime/API changes.

## Protocol fuzzing

(`repro-fuzz-protocol`), corrupt MessagePack, lying length prefixes, >64MB frames, torn/coalesced frames, and pre-auth commands never crash or wedge the server; the pre-auth gate never leaks state.

## Chaos / fault injection

(`repro-chaos-fault-injection`), at-least-once redelivery when a worker dies mid-job; a heartbeated-then-dropped job is not double-dispatched but is reclaimed by lock-expiry; lock-expiry under contention loses nothing; cron next-run is monotonic under clock skew/DST.

## Race / concurrency

(`repro-race-concurrency`), N concurrent PULLs → exactly one delivery; concurrent same-`jobId` PUSH → exactly one job; active re-add is an idempotent skip; cancel-during-active is a safe no-op; a stale ACK racing lock-expiry never double-completes; K-workers×M-jobs drain processes each exactly once.

## Crash-recovery

(`repro-chaos-crash-recovery`), under `SIGKILL`: durable jobs are never lost, ACKed durable jobs stay completed, paused-state and DLQ entries persist, an active-at-crash job is recovered, and multi-cycle crash fuzzing loses nothing cumulatively.

## Soak / endurance

(`repro-chaos-soak`), sustained produce/consume with a worker killed every ~400ms: no job lost (server-authoritative), p99 does not drift, WAL stays bounded, internal collections return to baseline after drain (no leak). Env-tunable (`SOAK_MS`) for multi-hour runs.

## Stress / degradation

(`repro-stress-degradation`), a huge backlog stays bounded and responsive then drains; 100 slowloris connections are all terminated by the stall bound while a healthy client stays fast; >50 pipelined commands on one socket all complete; latency returns to baseline after a spike.

## Upgrade / rolling restart

(`repro-upgrade-restart`), graceful `SIGTERM` flushes the write buffer so even buffered jobs survive; waiting/completed(+result)/paused/DLQ state all round-trip a restart; rolling restarts under load lose nothing.

## Long-running semantics

(`repro-longrunning-semantics`), cron next-run does not drift across thousands of ticks (incl. DST); `jobResults` and the custom-id dedup map stay bounded under pressure; the DLQ is bounded to `maxEntries` and remains retryable.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.29](/blog/bunqueue-v2-8-29/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.30) · [Commits since v2.8.29](https://github.com/egeominotti/bunqueue/compare/v2.8.29...v2.8.30) · [Full changelog](/changelog/) · [All posts](/blog/)
