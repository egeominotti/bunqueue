---
title: "bunqueue v2.8.40"
description: "Fixes 5 bugs and ships 3 additions. The CLI now derives command routing and command discovery from one canonical registry."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-40.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.40</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs and ships 3 additions. The CLI now derives command routing and command discovery from one canonical registry.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.40

```bash title="bun"
bun add bunqueue@2.8.40
```

```bash title="npm"
npm install bunqueue@2.8.40
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Property campaigns cover arbitrary argv, safe-integer boundaries, Unicode,
  JSON values, serialization and flag permutations. Real TCP/SQLite E2E tests
  cover every CLI command, restart persistence, direct-API parity, malformed
  inputs, concurrent idempotency, duplicate ACKs and killed long-polls.
- A targeted mutation campaign killed all five parser, router, codec, JSON and
  cancellation mutants. Workflow retry tests now observe terminal state
  instead of sleeping for eight seconds, cutting the reported retry case from
  about 8.1 seconds to about 2.1 seconds under the isolated parallel suite.
- The real-TCP count regression harness now binds a kernel-assigned port, so
  parallel CI cannot collide with an unreserved random port.

## Bugfixes

- The CLI now derives command routing and command discovery from one canonical
  registry. Help, aliases and the command builder expose the same surface,
  including `ping` and `backup create`.
- `--json` emits exactly one JSON document on local, remote and error paths.
  Safe-integer parsing rejects imprecise values, while negative JSON
  primitives, equivalent flag spellings and independent flag ordering retain
  their intended meaning.
- Closing a TCP connection now cancels its pending pull. An interrupted
  long-poll cannot claim the next job, leave a hidden waiter or consume
  rate/concurrency resources while waiting for a shard lock.

## Bugfixes

- TCP, SQLite, CLI and cloud transports share a canonical MessagePack codec.
  Hostile object keys such as `__proto__` round-trip without renaming,
  collisions, data loss or prototype pollution while ordinary frames retain
  the fast decoder path.
- Active-to-waiting transitions, per-queue DLQ configuration, stall counters
  and related queue indexes now persist and recover coherently. The generated
  broker model covers 69 lifecycle, ordering, resource and persistence
  invariants.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.39](/blog/bunqueue-v2-8-39/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.40) · [Commits since v2.8.39](https://github.com/egeominotti/bunqueue/compare/v2.8.39...v2.8.40) · [Full changelog](/changelog/) · [All posts](/blog/)
