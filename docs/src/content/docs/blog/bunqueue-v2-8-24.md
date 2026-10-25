---
title: "bunqueue v2.8.24"
description: "Ships 3 performance improvements. Deterministic micro-benchmark (addData, 111-byte frames coalesced into one read): F=1000 2.78ms → 0.043ms (~65×), F=5000 61.1ms → 0.21ms (~291×)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-24.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-27"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.24</em></h1>
  <p class="bq-hero-sub">Ships 3 performance improvements. Deterministic micro-benchmark (addData, 111-byte frames coalesced into one read): F=1000 2.78ms → 0.043ms (~65×), F=5000 61.1ms → 0.21ms (~291×).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.24

```bash title="bun"
bun add bunqueue@2.8.24
```

```bash title="npm"
npm install bunqueue@2.8.24
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance: fewer copies and an O(Q²) background scan removed

- **Dropped a redundant `new Uint8Array(data)` copy** in both TCP data handlers (`src/infrastructure/server/tcp.ts`, `src/client/tcp/connection.ts`). `addData` already copies the incoming bytes into its own buffer synchronously and never retains the caller's buffer, so the defensive wrapper was one full copy per read with no purpose.
- **`cleanEmptyQueues` O(Q²) → O(Q)** (`src/application/cleanupTasks.ts`). The 10s background sweep called the `shard.dlq` getter, which rebuilds a `Map` of **every** queue's DLQ entries on each access, once per queue, making the per-shard sweep quadratic in the queue count. Replaced with the O(1) `shard.getDlqCount(queue)` counter lookup. Read-side only; no behavior change.

## Performance

`FrameParser.addData` (`src/infrastructure/server/protocol.ts`), used by **both** the TCP server (incoming commands) and the TCP client (incoming responses), resliced the entire remaining buffer after **every** decoded frame: `this.buffer = this.buffer.slice(4 + len)`. When many frames arrive coalesced in a single TCP read, exactly what deep pipelining and OS segment coalescing produce for `PUSHB`/`ACKB` bursts, that is O(tail) per frame, i.e. **O(F²)** in the number of frames per read. Replaced with a read-offset cursor that advances in O(1) per frame and compacts the unconsumed tail once, making the pass **O(total bytes)**.

- Deterministic micro-benchmark (`addData`, 111-byte frames coalesced into one read): F=1000 **2.78ms → 0.043ms (~65×)**, F=5000 **61.1ms → 0.21ms (~291×)**. Linear scaling restored (5× frames → ~5× time).
- End-to-end (M1 Max, Bun 1.3.14): TCP push throughput **+20–36%** at 1K–5K-job scales where frame coalescing is heaviest, neutral at larger scales; `tcp-bench` round-trip latency **p50 48µs → 43µs (−10%)**. Embedded mode is unaffected (it does not use the wire framing).
- Behavior is byte-for-byte identical: frame bodies are still returned as copies, partial-frame buffering, the 64MB `FrameSizeError` guard, and the slowloris `hasPartialFrame`/`bufferedBytes` getters are preserved. New E2E suite `scripts/tcp/test-frameparser-pipelining-e2e.ts` validates 2000-way pipelined coalescing, 256KB multi-segment frames, 5000-job exactly-once processing, and boundary-size payload integrity.

## Docs: benchmarks page re-measured and corrected

Re-ran every published benchmark on an Apple M1 Max (Bun 1.3.14), reporting the **median of 3 runs** per cell, and updated `guide/benchmarks`. Embedded numbers reproduce (and are higher than before: bulk push peaks ~630K ops/sec). The **TCP “Process” figures were corrected**: the old 20–34K ops/sec single-worker numbers predate the lease-bounding over-pull fix and no longer reproduce, a single worker at `concurrency:10` is bounded by per-job pull round-trip latency (~182 ops/sec), scaling to ~4,900 ops/sec at `concurrency:50`. The methodology section now also documents that the TCP “Push” column issues 100 concurrent adds per batch (not sequential) and notes the `BUNQUEUE_EMBEDDED` env caveat when running `bench/comprehensive.ts`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.23](/blog/bunqueue-v2-8-23/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.24) · [Commits since v2.8.23](https://github.com/egeominotti/bunqueue/compare/v2.8.23...v2.8.24) · [Full changelog](/changelog/) · [All posts](/blog/)
