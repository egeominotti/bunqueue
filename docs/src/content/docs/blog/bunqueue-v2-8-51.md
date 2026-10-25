---
title: "bunqueue v2.8.51"
description: "Production hardening for atomic cross-SDK flows, dependency completion durability and fail-closed release gates."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-51.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.51</em></h1>
  <p class="bq-hero-sub">Production hardening for atomic cross-SDK flows, dependency completion durability and fail-closed release gates.</p>
</div>

Production hardening for atomic cross-SDK flows, dependency completion
durability and fail-closed release gates. The release adds executable
invariant, mutation and real-broker E2E coverage for every official SDK while
preserving the existing wire protocol.

#### To install bunqueue v2.8.51

```bash title="bun"
bun add bunqueue@2.8.51
```

```bash title="npm"
npm install bunqueue@2.8.51
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## FlowProducer and SDKs

- All six external SDKs now preallocate complete flow graphs and commit them
  with one broker-side `PUSHF` command. Tree, bulk, chain and fan-in builders
  validate unsupported lifetimes, caller-owned topology, reserved metadata,
  duplicate IDs and the broker's returned ID/queue snapshot before exposing a
  result.
- Legacy SDK `UpdateParent` calls remain compatible when a declared child
  finishes before the backpatch. Completed, active, failed and
  `removeOnComplete` races update only the child's ownership; parent topology
  and scheduling never transition twice. Durable DLQ data and the
  `flow_failures` outbox are re-keyed transactionally, retaining the original
  failure reason across restart.
- Each SDK now runs deterministic, shrinkable generated invariants with its
  native property framework: fast-check, Hypothesis, Eris, Rapid, proptest or
  StreamData. Separate pinned mutation campaigns challenge the pure planners
  and committed-snapshot validators with StrykerJS, mutmut, Infection,
  Gremlins, cargo-mutants and Muex.
- Every SDK carries a language-specific invariant reference and contributor
  instructions. Its README includes runnable atomic-flow examples and the
  exact property, mutation, real-broker E2E and isolated sandbox commands.
- Flow dependency promotion now checkpoints state/timeline before workers are
  notified. `removeOnComplete` ACK, optimized ACKB and late stall ACK paths
  atomically replace the removed child with a payload-free SQLite completion
  proof. Recent unreferenced proofs remain FIFO-bounded; proofs owned by live
  waiting parents are pinned until the final reverse edge is durably released.
  Recovery reconstructs ownership before pruning—even when the configured cap
  shrinks—never trusts an orphan result row as completion, preserves
  already-promoted parents after proof eviction, and prevents a reused custom
  ID from inheriting an older generation's completion.

## CI/CD

- The six-language SDK workflow is now a reusable, fail-closed dependency of
  the main quality gate. Version checks, binaries, container publication and
  GitHub releases cannot run unless core, documentation and every SDK job
  succeeds; a structural regression suite mutation-checks each release-DAG
  edge.
- TypeScript SDK publication is an explicit manual workflow with a requested
  version, current-`origin/main` enforcement, frozen lockfile, package-content
  validation, provenance, preflight registry/tag checks and tag creation only
  after `bun publish` succeeds.
- Scheduled/manual SDK mutation jobs use pinned runtimes and mutation engines;
  the ordinary SDK gate continues to run the faster generated properties on
  every release-capable change.

---

[← bunqueue v2.8.50](/blog/bunqueue-v2-8-50/) · [Full changelog](/changelog/) · [All posts](/blog/)
