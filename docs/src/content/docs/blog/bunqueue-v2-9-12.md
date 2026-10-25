---
title: "bunqueue v2.9.12"
description: "Three regression suites pin the 2.9.11 write path on failure paths, as a guard for any future write-path optimization."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-12.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-08"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.12</em></h1>
  <p class="bq-hero-sub">Three regression suites pin the 2.9.11 write path on failure paths, as a guard for any future write-path optimization.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.12

```bash title="bun"
bun add bunqueue@2.9.12
```

```bash title="npm"
npm install bunqueue@2.9.12
```

```bash title="docker"
TAG=2.9.12
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Performance

**Retried jobs no longer each carry their own hidden class: 60% less heap per
DLQ entry, and under sustained failures the broker holds 58% fewer strings and
28% fewer heap objects.** A job's retry history lives in a non-enumerable
Symbol property, added on its first retry and cleared when the job completes,
enters the DLQ or is retried manually. Clearing used `delete`, which gave every
such job a hidden class (`Structure`) of its own; persisting the job then built
a property-name cache of about 47 strings for it. That cost
about 1 KB per retained job (DLQ entries are kept up to 10,000 per queue by
default, completed jobs up to 50,000). Clearing now assigns `undefined`, so a
retried job keeps the shared hidden class. Job state, persistence, JSON,
MessagePack and wire output are identical, and reading the state still returns
`null` once cleared. The one visible difference: `console.log`, `Bun.inspect`
and test snapshots of an internal `Job` object (for example from
`QueueManager.getJob()`) that was retried and later completed or moved to the
DLQ now show the
cleared property as `[Symbol(bunqueue.dlqRetryState)]: undefined`, and
`Object.getOwnPropertySymbols` lists it.

| Metric (same host, same workload)                         | 2.9.11    | 2.9.12    | Change |
| --------------------------------------------------------- | --------- | --------- | ------ |
| Heap per DLQ entry of a retried job (isolated benchmark)  | 1,768 B   | 698 B     | -60%   |
| Hidden classes (`Structure`) created per DLQ entry        | 1.00      | 0.01      | -99%   |
| `Structure` objects created from 60 s to the end of a run | +10,478   | none      | flat   |
| Property-name enumerators alive at the end of a run       | 16,806    | 0         | -100%  |
| Strings alive at the end of a run                         | 1,318,866 | 551,813   | -58%   |
| Heap objects alive at the end of a run                    | 2,748,629 | 1,972,509 | -28%   |
| Peak RSS over the run                                     | 865 MB    | 807 MB    | -7%    |
| Jobs processed/s at saturation, 2 load processes          | 2,425     | 2,489     | noise  |

The run is 180 s of a realistic mixed workload on the broker in its own
process: 16 TCP queues with workers returning results, 5% of jobs failing twice
and reaching the DLQ, 10% reporting progress, priorities, delays and duplicate
custom IDs, 16 closed-loop HTTP clients, dashboard polling and 2 SSE
subscribers. Native macOS arm64 (18 cores, 64 GB), Bun 1.4.2, SQLite file
persistence, measured 2026-10-08 against `c43442c9`. Heap figures are one run
each; the isolated per-entry figures were repeated twice; the saturation
figures are the mean of two 90 s runs, and their difference is within
run-to-run variation. These are dated host engineering measurements, not
published benchmark results.

## Testing

- **Three regression suites pin the 2.9.11 write path on failure paths**, as a
  guard for any future write-path optimization.
  `test/repro-write-path-faults.test.ts` runs a 36-scenario fault-injection
  matrix (result and state writes failing always, once or on a given call;
  single and batch ACKs on jobs already on disk; unserializable results)
  and compares error, persisted state, result rows, job index, in-memory
  completion sets, disk-full flag and log lines with output recorded from
  2.9.11 (`test/fixtures/write-path-faults-2.9.11.jsonl`). It runs in a child
  process with the shard count pinned (`test/fixtures/pin-shard-count.ts`),
  because a batch ACK extracts its jobs in shard order and the shard count
  follows the host's CPU count.
  `test/repro-write-path-equivalence.test.ts` covers full-disk failures for
  still-buffered jobs, unserializable results, an ACK after the storage
  closed, telemetry around a rolled-back obliteration, payload mutation after
  an event, the backup boundary, and a trigger-based invariant that a completed
  row never exists without its result row.
  `test/repro-write-path-contention.test.ts` holds the database lock from
  another process and checks that a result-bearing ACK fails once with its
  jobs left active, and that telemetry reaches disk inside a sequential
  `await` loop. All three pass unchanged on 2.9.11 and on 2.9.12.

## Investigated, not shipped

Profiling the same workload showed the broker's main thread spending most of
its time in synchronous SQLite writes, several commits per processed job.
Grouping each ACK's result and state writes into one transaction, and writing
per-event telemetry once per event-loop turn, raised throughput substantially
in that profile and reproduced 2.9.11 under injected faults and lock
contention. On a physically full filesystem, though, changing commit
boundaries alone changes when the WAL grows and checkpoints, and therefore
which write fails, including an ACK's outcome. Neither is part of this
release, which changes no behavior; the regression suites above pin the
behavior any future version of them must keep.

## Documentation

- **The docs header blurs the page behind it in Chrome and Firefox again.** The
  stylesheets declared `backdrop-filter` before `-webkit-backdrop-filter`, and
  Lightning CSS, which minifies the site's CSS, kept only the prefixed form, so
  only Safari blurred and other browsers showed text through the translucent
  header. The prefixed declaration now comes first and both ship.
- **The homepage "New" tags no longer wrap to "Ne/w" on phones.** The tag
  stays on one line and the announcement text wraps beside it.
- **A contact address, founder@bunqueue.dev, is in the site footer** and in the
  publisher of the site-wide SoftwareApplication and per-page TechArticle
  structured data.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.11](/blog/bunqueue-v2-9-11/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.12) · [Commits since v2.9.11](https://github.com/egeominotti/bunqueue/compare/v2.9.11...v2.9.12) · [Full changelog](/changelog/) · [All posts](/blog/)
