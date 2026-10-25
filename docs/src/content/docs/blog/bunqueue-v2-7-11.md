---
title: "bunqueue v2.7.11"
description: "Fixes 1 bug. defineConfig caused \"Failed to listen at 0.0.0.0\" when used in config file (Issue #85, reported by @timnew), src/main.ts re-executes its top-level dispatch on every import."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-11.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-11"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.11</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. defineConfig caused "Failed to listen at 0.0.0.0" when used in config file (Issue #85, reported by @timnew), src/main.ts re-executes its top-level dispatch on every import.</p>
</div>

#### To install bunqueue v2.7.11

```bash title="bun"
bun add bunqueue@2.7.11
```

```bash title="npm"
npm install bunqueue@2.7.11
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`defineConfig` caused "Failed to listen at 0.0.0.0" when used in config file** (Issue #85, reported by @timnew), `src/main.ts` re-executes its top-level dispatch on every import. Running `bunqueue start -c typed.ts` started the server, then `loadConfigFile()` imported the user config which imports `defineConfig` from `'bunqueue'` → resolves to `dist/main.js` → top-level code sees `argv[2] === 'start'` and re-invokes the CLI, attempting a second bind on the same port. Wrapped the top-level CLI/server dispatch and the Logger env-var bootstrap in `if (import.meta.main)` so importing the package entry (for `defineConfig` or other re-exports) has no side effect. Behavior when `src/main.ts` is the actual entry (e.g. `bun run src/main.ts`, compiled binary) is unchanged.

## Tests

- New regression test `test/issue-85-config-import-side-effect.test.ts`, spawns a subprocess that imports `src/main.ts` with `process.argv` emulating `bunqueue start`, asserts no server banner/bind logs.

---

[← bunqueue v2.7.10](/blog/bunqueue-v2-7-10/) · [Full changelog](/changelog/) · [All posts](/blog/)
