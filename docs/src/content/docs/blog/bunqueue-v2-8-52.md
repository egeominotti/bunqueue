---
title: "bunqueue v2.8.52"
description: "Fixes 2 bugs. The binary-build workflow now quotes the GitHub Actions command-file path used for version outputs, resolving the SC2086 failure reported by Actionlint when ShellCheck is available on the CI runner."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-52.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.52</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. The binary-build workflow now quotes the GitHub Actions command-file path used for version outputs, resolving the SC2086 failure reported by Actionlint when ShellCheck is available on the CI runner.</p>
</div>

#### To install bunqueue v2.8.52

```bash title="bun"
bun add bunqueue@2.8.52
```

```bash title="npm"
npm install bunqueue@2.8.52
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- The binary-build workflow now quotes the GitHub Actions command-file path
  used for version outputs, resolving the `SC2086` failure reported by
  Actionlint when ShellCheck is available on the CI runner.
- The release-graph regression suite now rejects unquoted redirections to
  GitHub command files, so this class of workflow failure is detected by the
  regular unit and sandbox suites even on developer machines without
  ShellCheck.

---

[← bunqueue v2.8.51](/blog/bunqueue-v2-8-51/) · [Full changelog](/changelog/) · [All posts](/blog/)
