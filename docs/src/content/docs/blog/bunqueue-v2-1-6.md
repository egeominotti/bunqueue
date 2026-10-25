---
title: "bunqueue v2.1.6"
description: "Fixes 2 bugs and ships 2 additions. S3 backup hardening - 10 bug fixes with 33 new tests: - Replace silent catch in cleanup with proper logging - Reject retention < 1 and intervalMs < 60s in config validation - Validate SQLite magic bytes…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.6</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs and ships 2 additions. S3 backup hardening - 10 bug fixes with 33 new tests: - Replace silent catch in cleanup with proper logging - Reject retention &lt; 1 and intervalMs &lt; 60s in config validation - Validate SQLite magic bytes…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.1.6

```bash title="bun"
bun add bunqueue@2.1.6
```

```bash title="npm"
npm install bunqueue@2.1.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- 33 new S3 backup tests covering config validation, backup/restore operations, cleanup, and manager lifecycle
- Documentation for gzip compression, SHA256 checksums, `.meta.json` files, scheduling details, AWS env var aliases, and restore safety notes

## Bugfixes

- **S3 backup hardening** - 10 bug fixes with 33 new tests:
  - Replace silent catch in cleanup with proper logging
  - Reject retention < 1 and intervalMs < 60s in config validation
  - Validate SQLite magic bytes before restore to prevent data corruption
  - Guard cleanup against retention=0 deleting all backups
  - Add S3 list pagination to handle >100 backups
  - Run WAL checkpoint before backup to include uncheckpointed data
  - Replace blocking gzipSync/gunzipSync with async CompressionStream
- **Flaky sandboxedWorker concurrent test** - Poll all 4 job results in parallel instead of sequentially to avoid exceeding the 5s test timeout.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.1.5](/blog/bunqueue-v2-1-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.1.6) · [Commits since v2.1.4](https://github.com/egeominotti/bunqueue/compare/v2.1.4...v2.1.6) · [Full changelog](/changelog/) · [All posts](/blog/)
