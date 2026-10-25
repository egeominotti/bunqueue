---
title: "bunqueue v2.8.50"
description: "Fixes 12 bugs. Production hardening for the experimental workflow engine and FlowProducer."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-50.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.50</em></h1>
  <p class="bq-hero-sub">Fixes 12 bugs. Production hardening for the experimental workflow engine and FlowProducer.</p>
</div>

Production hardening for the experimental workflow engine and `FlowProducer`.
Workflow runtime changes remain isolated under `src/client/workflow/`.
Flow creation now has a broker-side `PUSHF` primitive and schema version 27;
external SDK source code is unchanged and remains wire-compatible.

#### To install bunqueue v2.8.50

```bash title="bun"
bun add bunqueue@2.8.50
```

```bash title="npm"
npm install bunqueue@2.8.50
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Registration validates the complete graph: reserved/internal names, duplicate branch
  paths, loop namespaces, unsupported inline node kinds and unsafe numeric bounds are
  rejected before a run can start.
- `retry`, timeout, iteration and pagination options require finite safe integers with
  contract-specific bounds. Inline builders accept executable steps only.
- Sub-workflow polling and timeout are configurable. Expiry fails the parent but does
  not claim to have forcibly cancelled a still-running child.
- Workflow event types, execution/step records and public node definitions are exported
  as named types. Source responsibilities were split into files below the repository's
  300-line limit without changing the import path.

## FlowProducer

- **Every Bun flow creation API is now atomic.** `add`, `addBulk`, `addChain`,
  `addBulkThen` and `addTree` preallocate the final IDs and send one `PUSHF`
  graph. Validation and ownership checks finish before mutation; all affected
  shards are locked in order, and configured SQLite commits every row before a
  worker can observe a leaf.
- **Malformed or oversized graphs fail closed.** The client and broker enforce
  bounded jobs/depth/data, strict runtime wire types, reserved metadata,
  duplicate/missing/asymmetric edges, cycles, mutually exclusive failure
  policies and unsupported repeat/dedup/debounce lifetimes. Topology validation
  and committed-snapshot indexing are O(V+E), including wide 10,000-job flows.
- **Terminal child policy is restart-safe.** All four failure flags persist on
  jobs, and the new `flow_failures` outbox commits with the terminal child.
  Recovery applies fail/remove/ignore/continue idempotently before workers
  start; queryable failure values live until the parent terminates.
- **Manual dependency removal is a real detach.** Parent dependencies/children,
  child ownership/metadata, reverse indexes, protected results and both SQLite
  rows transition together. An active child detached this way cannot later
  fail its former parent.
- **Flow Job and traversal APIs now expose authoritative state.** TCP errors,
  readiness errors and lock-extension errors are thrown; object progress uses
  the canonical numeric/message wire shape; serialization no longer leaks
  internal metadata. `getFlow` honors zero bounds and rejects missing,
  cyclic, malformed or cross-linked descendants instead of returning a partial
  tree.
- **Identifier tombstones cannot resurrect dependencies.** A retained
  completion/result/timeout or an ID still referenced by a waiting parent
  rejects reuse, preventing a removed prior generation from making a new child
  look completed.
- **SQLite initial state now matches the scheduler.** Durable single, batch and
  flow inserts retain `prioritized` and `waiting-children` instead of flattening
  both to `waiting`, keeping recovery diagnostics and persistence invariants
  coherent with the public state.

## Bugfixes

- **Retries now remain bounded across crash recovery.** Attempt counts are cumulative
  for a step occurrence instead of restarting when its node is re-entered, so a
  repeatedly recovered step cannot exceed its declared `retry` budget.
- **Workflow timeouts accept every `PromiseLike` and remain correct beyond the
  platform timer ceiling.** Long deadlines are armed in bounded chunks rather than
  overflowing a 32-bit timer, and timed-out handlers receive an `AbortSignal` so
  cooperative downstream work can stop.
- **Signals are atomic and first-writer-wins.** Recording the payload and claiming the
  parked run happen transactionally; concurrent or repeated deliveries cannot replace
  the accepted payload or enqueue two resume chains. A failed enqueue restores an
  actionable persisted state instead of losing the approval.
- **Crash recovery no longer loses or duplicates sub-workflows.** A restarted parent
  adopts its persisted child, republishes missing work without creating a second child,
  and keeps the original child deadline rather than granting a fresh timeout window.
  Orphaned children become independently recoverable only after their owner is gone.
- **Branch, loop, map and sub-workflow decisions survive replay.** Chosen paths,
  iteration inputs, item snapshots and child identity are journaled before dispatch, so
  non-deterministic callbacks are not re-evaluated after a crash.
- **Definition drift now fails closed.** Registered workflows carry a deterministic
  definition hash plus an explicit revision. A persisted execution cannot be resumed
  under a renamed or structurally different graph and silently run the wrong node.
- **Failed executions are recovered through the unwind before any forward work is
  admitted.** Per-step compensation outcomes remain exactly-once, a write failure
  leaves an operator exit, and duplicate recovery cannot re-run a settled reversal.
- **Abandoned nested rollbacks stay terminal.** Resuming a parent no longer reopens a
  child explicitly abandoned as `failed`/`stuck`, so its compensators cannot run again
  after the operator accepted a partial rollback.
- **Map nodes persist honest per-item outcomes.** Running, completed and failed states,
  results, errors and lifecycle events are recorded without replaying successful items;
  compensation receives the matching item and result in reverse completion order.
- **Execution listing is deterministic.** SQLite applies filtering, total ordering and
  pagination in one query with stable tie-breakers and supporting indexes, eliminating
  duplicate or skipped rows on an unchanged result set.
- **Enqueue failures no longer strand unreachable executions.** A start that cannot
  publish its first node removes the newly inserted row; later publications preserve a
  recoverable cursor and error instead of handing back a run that can never advance.
- **Workflow identifiers are collision-resistant in production.** Real execution IDs
  use 128 bits of CSPRNG entropy; deterministic simulated-clock entropy remains isolated
  to tests and replay campaigns.

## Documentation and verification

- Rewrote the internal workflow reference and all nine public guide pages around the
  actual durability contract: at-least-once external effects, one engine per process,
  live (non-replayed) events, first-writer signal semantics, offset pagination, child
  ownership and the difference between timeout and cancellation.
- Corrected and expanded the quickstart, approval, rollback, AI-agent and SDK examples.
  Provider effects use stable idempotency keys, startup calls `recover()`, durable state
  is polled explicitly, and rollback examples reconcile ambiguous provider outcomes.
- Added package-backed tests for every offline documentation example and strengthened
  weak workflow assertions so they check exact ordering, per-item rollback, branch
  output, archive boundaries and emitted events.
- Added executable FlowProducer guide tests for the Quick Start, chain, fan-in,
  parent-first tree, queue defaults, bounded traversal and failure-value APIs.
- Expanded the fast-check command model with generated workflow graphs and operator
  histories. It now checks definition identity, legal transitions, no
  loss/resurrection, exclusive delivery, bounded retry/timeout behavior, branch and
  loop decision stability, child ownership, map outcomes, compensation exactly-once,
  deterministic pagination and recovery idempotency against real SQLite and a TCP
  broker.
- Added a separate Fast-Check FlowProducer graph model plus realistic dynamic-port
  TCP/SQLite E2E coverage for three cross-queue workers, exact-once execution,
  child-first ordering, failure metadata and broker restart.

---

[← bunqueue v2.8.49](/blog/bunqueue-v2-8-49/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.50) · [Commits since v2.8.49](https://github.com/egeominotti/bunqueue/compare/v2.8.49...v2.8.50) · [Full changelog](/changelog/) · [All posts](/blog/)
