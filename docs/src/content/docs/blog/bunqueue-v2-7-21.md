---
title: "bunqueue v2.7.21"
description: "Fixes 4 bugs. MCP setup docs now make the install step explicit: every guide (README, MCP guide, quickstart, server, cron, use-cases) shows bun add bunqueue (or bun add -g bunqueue) before bunx bunqueue-mcp, and a caution box explains the…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-21.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.21</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. MCP setup docs now make the install step explicit: every guide (README, MCP guide, quickstart, server, cron, use-cases) shows bun add bunqueue (or bun add -g bunqueue) before bunx bunqueue-mcp, and a caution box explains the…</p>
</div>

#### To install bunqueue v2.7.21

```bash title="bun"
bun add bunqueue@2.7.21
```

```bash title="npm"
npm install bunqueue@2.7.21
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

`bunqueue-mcp` is a binary **bundled inside** the `bunqueue` package, not a standalone npm package. Running `bunx bunqueue-mcp` (or `npx bunqueue-mcp`) without `bunqueue` installed made the launcher try to download a package named `bunqueue-mcp`, which doesn't exist → `error: GET https://registry.npmjs.org/bunqueue-mcp - 404`. The runtime is unchanged; this is a docs/invocation fix.

- **MCP setup docs now make the install step explicit**: every guide (README, MCP guide, quickstart, server, cron, use-cases) shows `bun add bunqueue` (or `bun add -g bunqueue`) before `bunx bunqueue-mcp`, and a caution box explains the 404.
- **All JSON MCP configs switched to `args: ["--package=bunqueue", "bunqueue-mcp"]`**: copy-paste safe: `bunx` resolves the bundled binary straight from the `bunqueue` package with no separate install. The skill configs use the same form; `npx` was replaced with `bunx` (the MCP entry's shebang is `#!/usr/bin/env bun`).
- **Removed the misleading `bunx bunqueue-mcp --help`** from troubleshooting, the MCP entry doesn't parse CLI args (it starts the stdio server immediately).
- **Repo `.mcp.json` now runs the local source** (`bun run src/mcp/index.ts`) instead of fetching from npm.

---

[← bunqueue v2.7.20](/blog/bunqueue-v2-7-20/) · [Full changelog](/changelog/) · [All posts](/blog/)
