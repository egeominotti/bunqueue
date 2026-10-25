---
title: "bunqueue v2.8.13"
description: "Fixes 3 bugs. moveToFailed() sends the stack."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-13.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.13</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. moveToFailed() sends the stack.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.13

```bash title="bun"
bun add bunqueue@2.8.13
```

```bash title="npm"
npm install bunqueue@2.8.13
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

The 2.8.11 fix wired the failure stack through the **natural-throw** path only: a
processor that `throw`s gets its stack sent on `FAIL` (persisted server-side) and set
on the local `failed` event's `job.stacktrace`. A processor that catches the error and
reports it explicitly with `await job.moveToFailed(err)` went through a different code
path that never touched the stack, so, as @arthurvanl's repro showed, `job.stacktrace`
was `null` on the `failed` event and `queue.getJob(id).stacktrace` stayed `null`, while
an equivalent natural throw populated both.

- **`moveToFailed()` sends the stack.** The explicit handler now computes the stack
  lines and includes them on `FAIL` (`stack`, TCP) / `manager.fail(..., wireStack)`
  (embedded), so the server persists them exactly like the throw path, visible via
  `getJob()` and in DLQ entries.
- **Local `failed` event populated.** The manual-move handler now sets
  `job.stacktrace` (capped at `job.stackTraceLimit`) on the emitted job, matching the
  natural-throw behavior.
- The stack-splitting logic is now a single shared `computeStackLines()` helper used by
  both paths, so they can't drift apart again.

Reproduced in both modes with `test/repro-issue74-movetofailed-stacktrace.test.ts`
(local event + server-side `getJob()` persistence, embedded and TCP).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.12](/blog/bunqueue-v2-8-12/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.13) · [Commits since v2.8.12](https://github.com/egeominotti/bunqueue/compare/v2.8.12...v2.8.13) · [Full changelog](/changelog/) · [All posts](/blog/)
