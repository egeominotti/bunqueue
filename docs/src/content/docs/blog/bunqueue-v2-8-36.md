---
title: "bunqueue v2.8.36"
description: "Ships 16 additions. A fast-check asynchronous command model now generates lifecycle, batch, dependency, DLQ, limiter, queue-control, and actual SIGKILL/restart histories against a fresh TCP broker and SQLite database per run."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-36.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.36</em></h1>
  <p class="bq-hero-sub">Ships 16 additions. A fast-check asynchronous command model now generates lifecycle, batch, dependency, DLQ, limiter, queue-control, and actual SIGKILL/restart histories against a fresh TCP broker and SQLite database per run.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.36

```bash title="bun"
bun add bunqueue@2.8.36
```

```bash title="npm"
npm install bunqueue@2.8.36
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- A `fast-check` asynchronous command model now generates lifecycle, batch,
  dependency, DLQ, limiter, queue-control, and actual `SIGKILL`/restart
  histories against a fresh TCP broker and SQLite database per run. After every
  command it verifies API state, aggregate counts, lock tokens, MessagePack
  payloads, priority, physical rows, DLQ membership, and persisted queue
  controls. Failures shrink and replay by seed via `bun run test:model`.
- The first campaign found and permanently covers two crash-durability bugs:
  `Update` changed payload only in memory, and `ChangePriority` failed to persist
  priority/LIFO ordering. Both mutations now flush a pending buffered insert
  before updating SQLite and survive restart.
- Repeated crash recovery now persists each job's cumulative `stallCount` and
  the queue's complete custom stall policy before classifying active work.
  Recovery, heartbeat stalls, and expired locks all enforce both `maxAttempts`
  and `maxStalls`; terminal recovery restores its DLQ row exactly once even
  across repeated restarts.
- TTL expiry now deletes the persisted row and cancels any pending write-buffer
  insert in the same logical transition that removes the job from its heap,
  counters and indexes. Expired work cannot reappear through `GetState` or after
  restart.
- Queue obliteration now removes dependency-gated jobs from `waitingDeps`,
  `waitingChildren`, and the reverse dependency index, then uses the complete
  removed-ID set to purge global indexes and SQLite. Public embedded and TCP
  job counts now consistently expose the `waiting-children` bucket, including
  zero after obliteration.
- Manual and expiry-based DLQ purge now removes terminal jobs from `jobIndex`,
  results, logs, buffered writes, and SQLite in one queue-scoped transactional
  cleanup. Repeated expiry cleanup is idempotent and cannot delete a newer live
  generation or another queue's entry.
- Reusing a terminal custom ID now retires its prior DLQ generation before
  admitting the replacement. PUSH and PUSHB acquire the target and prior-owner
  shards in deterministic order and revalidate after locking; live custom IDs
  remain globally idempotent and the broker never exposes two generations with
  the same `jobs.id`.
- Management commands that claim active work (`MoveToDelayed`, `MoveToWait`,
  `MoveToWaitingChildren`, and active `Discard`) now release both the live lease
  and TCP-client ownership through one idempotent cleanup. No stale lock or
  client tracking remains after the job leaves `active`.
- The full sandbox gate exposed a tenth persistence-boundary defect after
  adding durable stall counters: legacy/low-level jobs without `stallCount`
  violated the new SQLite `NOT NULL` column. Single, buffered, batch, retry,
  and decode paths now normalize an omitted value to zero while the schema
  remains strict.
- The testing reference now tracks the complete 46-invariant production
  checklist across 15 categories and names whether each category is owned by
  the generated lifecycle model or a focused cron, flow, worker, protocol, or
  storage suite.

## What's new

- Rust and Elixir join TypeScript, Python, PHP, and Go as official protocol-v2
  SDKs, each with Queue, Worker, FlowProducer, verified TLS, auth-first lazy
  reconnect, typed errors, JavaScript-safe MessagePack handling, structured
  telemetry, native regression coverage, and the shared 17-check conformance
  driver.
- `bun run test:sandbox:sdk` builds six pinned toolchain images, validates
  package contents plus every native/conformance suite without runtime network
  access or host mounts, and writes complete logs, NDJSON resource samples,
  per-suite JSON, anomaly signals, and slow-test rankings.
- The TypeScript, Python, PHP, and Go clients gained frame-boundary,
  serialization, timeout/reconnect, option-forwarding, worker-lease, TLS, and
  telemetry regressions. Invalid outgoing data now fails through each SDK's
  typed error hierarchy before it can retain an in-flight slot or write a
  frame.
- Browser WebAssembly remains a documented future target because portable WASM
  has no raw-TCP API. A future browser bridge or capability-enabled WASI client
  must pass the same security, telemetry, and conformance contract before it is
  listed as official.
- All six native suites now include independent-connection idempotency and
  single-lease races, generated payload invariants, malformed-input fuzz
  corpora, bounded spike tests, and durable SIGKILL/restart recovery. Go also
  runs the race detector and a native fuzz target.
- Every SDK has an opt-in long-lived soak/stress profile. Weekly CI runs the
  profiles for 15 minutes, exercises the full runtime compatibility matrix, and
  checks package advisory databases; the authoritative local SDK gate remains
  deterministic, offline, and bounded.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.35](/blog/bunqueue-v2-8-35/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.36) · [Commits since v2.8.35](https://github.com/egeominotti/bunqueue/compare/v2.8.35...v2.8.36) · [Full changelog](/changelog/) · [All posts](/blog/)
