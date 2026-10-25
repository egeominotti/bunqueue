---
title: "bunqueue v2.8.1"
description: "Released as 2.8.1 because 2.8.0 was already taken on npm (an earlier accidental publish, since deprecated)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-1.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.1</em></h1>
  <p class="bq-hero-sub">Released as 2.8.1 because 2.8.0 was already taken on npm (an earlier accidental publish, since deprecated).</p>
</div>

> Released as 2.8.1 because 2.8.0 was already taken on npm (an earlier accidental publish, since deprecated). Same changes as intended for 2.8.0.

#### To install bunqueue v2.8.1

```bash title="bun"
bun add bunqueue@2.8.1
```

```bash title="npm"
npm install bunqueue@2.8.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Slimmer install: −91% `node_modules` for queue users (MCP SDK is now an optional peer dependency)

bunqueue shipped `@modelcontextprotocol/sdk` and `zod` as hard runtime
dependencies, so **every** consumer, including the majority who only use the
job queue, downloaded the MCP server's entire toolchain (the SDK, `zod`, and an
HTTP stack of `express`, `hono`, `ajv`, `jose`, `cors`, …). On top of that,
`bun` was declared as a `peerDependency`, which made package managers pull the
**61 MB `bun` runtime package** into the consumer's tree.

This release makes the MCP dependencies opt-in without removing any feature: the
`bunqueue-mcp` binary and the `bunqueue/mcp` export still ship, but the SDK is
now an **optional peer dependency** loaded lazily via dynamic `import()`. Queue
users pay nothing for a feature they don't use.

### Benchmark: `bun add bunqueue` in a clean project (measured)

| Metric                      | 2.7.x   | 2.8.0  | Delta             |
| --------------------------- | ------- | ------ | ----------------- |
| `node_modules` size         | 93 MB   | 8.2 MB | **−85 MB (−91%)** |
| Installed packages          | 117     | 7      | **−110 (−94%)**   |
| Cold install time           | 2.73 s  | 0.72 s | **3.8× faster**   |
| `@modelcontextprotocol/sdk` | bundled | absent | opt-in            |
| `zod`, `express`, `hono`    | bundled | absent | removed           |
| `bun` runtime package       | 61 MB   | absent | removed           |

Breakdown of the ~85 MB saved: **~61 MB** from dropping the `bun` peer
dependency, **~24 MB** from making the SDK + `zod` + HTTP stack optional.

### Migration

- **Queue users** (`bunqueue/client`, `Queue` / `Worker` / `Workflow`,
  `bunqueue/queue`, `bunqueue/workflow`), **no action required.** The public
  bundles contain zero SDK/`zod` code; your install simply gets smaller.
- **MCP users** (`bunqueue-mcp` or `import 'bunqueue/mcp'`), install the SDK
  once in the environment where the server runs:

  ```bash
  bun add @modelcontextprotocol/sdk
  ```

  `bunx --package=bunqueue bunqueue-mcp` does **not** auto-install optional peer
  dependencies. If the SDK is missing, the launcher fails fast with an
  actionable message and exit code 1:

  ```
  [bunqueue-mcp] The MCP server requires "@modelcontextprotocol/sdk" (an optional peer dependency).
  Install it with:  bun add @modelcontextprotocol/sdk
  ```

### Breaking (MCP only)

Setups that relied on the SDK being installed transitively must now add
`@modelcontextprotocol/sdk` explicitly. **The queue / worker / workflow API is
unchanged**, this is the only reason the release is a minor and not a patch.

### Implementation notes

- `src/mcp/index.ts` is now a thin launcher; the server implementation moved to
  `src/mcp/server.ts` (`export async function run()`), keeping the SDK out of the
  entrypoint's static import graph so it can be optional.
- `@modelcontextprotocol/sdk` → `peerDependencies` + `peerDependenciesMeta.optional`
  (also kept in `devDependencies` for build/test). `zod` removed from
  `dependencies` (it ships with the SDK; pinned in `devDependencies` for builds).
- `bun` removed from `peerDependencies`; `engines.bun` aligned to `>=1.3.9`.
  Declaring a runtime as a peer triggers spurious resolution warnings under
  npm/pnpm/yarn, `engines` is the correct field.
- `webhookTools` switched `z.url()` → `z.string().url()` for compatibility across
  the SDK's accepted `zod` range (`^3.25 || ^4.0`).

### Verification

`build:lib` clean · `tsc --noEmit` clean · 181 MCP tests pass · full unit suite
(5,479) green · non-MCP bundles verified free of SDK/`zod` · peer-optional
confirmed **not** installed by both `bun` and `npm` in a clean project.

Thanks to **@tmvc03** ([#90](https://github.com/egeominotti/bunqueue/discussions/90))
for reporting the footprint and proposing both the MCP split and the
`peerDependencies` → `engines` change.

---

[← bunqueue v2.7.22](/blog/bunqueue-v2-7-22/) · [Full changelog](/changelog/) · [All posts](/blog/)
