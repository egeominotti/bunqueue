---
title: "bunqueue v2.7.14"
description: "Fixes 7 bugs. worker register via CLI silently expires: Server auto-unregisters workers when their TCP connection closes; one-shot CLI commands disconnect immediately, so worker list right after worker register showed nothing."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-14.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.14</em></h1>
  <p class="bq-hero-sub">Fixes 7 bugs. worker register via CLI silently expires: Server auto-unregisters workers when their TCP connection closes; one-shot CLI commands disconnect immediately, so worker list right after worker register showed nothing.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.14

```bash title="bun"
bun add bunqueue@2.7.14
```

```bash title="npm"
npm install bunqueue@2.7.14
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`worker register` via CLI silently expires**: Server auto-unregisters workers when their TCP connection closes; one-shot CLI commands disconnect immediately, so `worker list` right after `worker register` showed nothing. CLI now prints a stderr warning explaining transience and pointing users to the SDK `Worker` class for persistence.
- **`pull` displayed `State: unknown`**: Server-side `Job` doesn't carry an explicit `state` field (state lives in `jobIndex`), so the PULL response omitted it. `src/cli/output.ts` now derives state from timestamps: `completedAt` → completed, exhausted retries (`attempts >= maxAttempts && startedAt > 0`) → unknown (since it could be DLQ), `startedAt > 0` → active, `runAt > now` → delayed, else waiting. Zero-signal jobs (no timestamps) still display `unknown` rather than a confident guess.
- **`job progress` and `job delay` errors conflated "not found" with "not active"**: Both handlers (`management.ts` Progress, `advanced.ts` MoveToDelayed) returned the literal string `Job not found or not active`. They now query `getJobState` on failure and emit either `Job not found` or `Job is not active (current state: X)`, so operators can act on the distinction.
- **Client ignored env vars `TCP_PORT`/`HOST`**: Server reads `TCP_PORT`, `HTTP_PORT`, `HOST`; CLI client only honored `--port`/`--host`. Asymmetric. Client now reads `TCP_PORT` (primary, matches server) plus `BUNQUEUE_TCP_PORT`/`BQ_TCP_PORT` aliases for `HOST` too. Priority: explicit CLI flag > env > default.
- **`queue clean` output said `Created 0 jobs`**: Batch-id formatter used a single "Created" verb for all responses with `ids` arrays. Now context-aware: `push` → `Created`, `queue clean` → `Cleaned`, `queue drain` → `Drained`, `dlq retry` → `Retried`, `dlq purge` → `Purged`. Falls back to `Affected` for unknown contexts.
- **`job result` printed literal `Result: undefined`**: When a job's result is `undefined`/`null` (job not completed or `removeOnComplete: true`), CLI now shows `No result available (job not completed or result was removed)` instead of stringifying undefined.
- **Short flags `-h` / `-v` triggered server start instead of help/version**: Global parser treated unknown short args as server flags. `-h` now aliases `--help`, `-v` aliases `--version` (server's existing `-H`/`-p`/`-t` short flags unchanged).

## Tests

- New `test/cli-issues.test.ts`, 11 reproducer tests covering each of the 8 CLI bugs above (subprocess-spawn approach with a real server on a dedicated port).
- Updated `test/server-handlers-core.test.ts`, 4 callsites converted to `await` after `handleGetProgress` became async (needed for state disambiguation).

## Internal

- `formatOutput` and `formatSuccess` (`src/cli/output.ts`) now accept an optional `subcommand` arg so batch-id responses can pick the right verb.
- `handleGetProgress` (`src/infrastructure/server/handlers/management.ts`) changed signature from sync `Response` to async `Promise<Response>` to support disambiguation via `getJobState`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.13](/blog/bunqueue-v2-7-13/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.14) · [Commits since v2.7.13](https://github.com/egeominotti/bunqueue/compare/v2.7.13...v2.7.14) · [Full changelog](/changelog/) · [All posts](/blog/)
