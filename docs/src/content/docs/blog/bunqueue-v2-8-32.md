---
title: "bunqueue v2.8.32"
description: "Fixes 3 bugs. TcpConnectionPool accepted maxInFlight and pipelining but never forwarded them to the clients it built, so every pooled connection ran with the default window of 100 no matter what you configured."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-32.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-11"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.32</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. TcpConnectionPool accepted maxInFlight and pipelining but never forwarded them to the clients it built, so every pooled connection ran with the default window of 100 no matter what you configured.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.32

```bash title="bun"
bun add bunqueue@2.8.32
```

```bash title="npm"
npm install bunqueue@2.8.32
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

When a queue had `setConcurrency(N)` and an ACTIVE job was claimed by `moveJobToDelayed` (the BullMQ-style "retry later" pattern inside a processor) or discarded to the DLQ, the claim path removed the job from processing without releasing its concurrency slot. Every sibling exit path (ack, fail, moveActiveToWait, lock expiry) releases; these two did not, and no background reconciliation exists, so N such claims wedged the queue permanently with no error anywhere, only `clearConcurrency` could unwedge it. Both paths now release inside the shard-lock section, mirroring the established semantics (uniqueKey freed on DLQ entry exactly like the fail path). Bonus from the same audit: discarding a WAITING job now releases its uniqueKey reservation (previously a re-add with the same key deduped against the DLQ'd job). Reproductions in `test/repro-slot-release-claim-paths.test.ts`, RED before, GREEN after, with control tests proving the sibling paths were already correct.

## Bugfixes

- `TcpConnectionPool` accepted `maxInFlight` and `pipelining` but never forwarded them to the clients it built, so every pooled connection ran with the default window of 100 no matter what you configured. Both are now forwarded and included in the pool sharing key, so queues with different windows no longer silently share a pool. The focused bench improved about 2 percent once the configured window was actually honored.
- `PUSHB` skipped the validation single `PUSH` enforces: an out-of-bounds option or a `dependsOn` pointing at a nonexistent job was accepted in a batch (the dependent job then sat in waiting-children forever). Batch pushes now run the same data, option and dependency gates, extended so intra-batch chains keep working regardless of order in the array (the auto-batcher groups concurrent adds arbitrarily), with self-references rejected explicitly. Batch throughput cost is under half a percent.
- Batch `PULL` without worker locks ignored its `timeout`, returning immediately instead of long-polling (workers using `useLocks: false` were busy-polling without knowing). The timeout is now validated and honored exactly like single `PULL`.

Every fix started from a RED reproduction (`test/repro-option-drop-class.test.ts`); the audit also REFUTED two suspected bugs before any code was touched (rate-limit tokens self-heal by design, and `getJobByCustomId` is already covered by the 2.8.31 atomic transition, proven by running the same reproduction against the pre-fix commit). The refuted paths keep their tests as permanent regressions.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.31](/blog/bunqueue-v2-8-31/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.32) · [Commits since v2.8.31](https://github.com/egeominotti/bunqueue/compare/v2.8.31...v2.8.32) · [Full changelog](/changelog/) · [All posts](/blog/)
