# Documentation Audit and Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and correct verifiable defects in the current public documentation and internal reference, then validate the generated site and documentation consumers.

**Architecture:** Keep the existing Astro/Starlight site and information structure. Audit independent content domains against source while one coordinator checks the built site, links, anchors and representative browser views. Fix documentation rather than changing product behavior to fit prose.

**Tech Stack:** Bun 1.4.4, TypeScript, Markdown/MDX, Astro/Starlight and the repository's existing documentation checks.

**Spec:** The user's request to audit all docs and correct deficiencies, plus AGENTS.md and docs/features/documentation-tooling.md. This is maintenance of the existing documentation, not a product redesign.

## Global Constraints

- All repository content stays in English; preserve user changes and historical release/benchmark facts.
- Use bun check and bun fmt exclusively for checking/formatting code; changed code files stay at or below 300 lines.
- Changes to product behavior require a separate reproduced defect, not a documentation workaround.
- Preserve existing anchors when possible; correct links and explain compatibility accurately.
- Keep generated API/reference trees generated; fix the responsible source or generator when needed.
- Honor existing commit/push/merge authorization, with skeptic PASS before every commit/push and exact-head CI afterward. No release/version/publication action.

## Review Focus

- Copy-pasted snippets must use exported APIs and explicit runtime/connection setup.
- Storage defaults and lease/retry guarantees must match the selected embedded/TCP/PostgreSQL mode.
- Existing inbound URLs and heading fragments must resolve in rendered HTML, not just source text.
- Historical examples must remain distinguishable from current recommendations.
- Narrow/mobile layouts, keyboard navigation and both themes must retain readable content and usable navigation.

### Task 1: Audit content contracts

**Files:** docs/src/content/docs/, docs/features/, docs/architecture.md, docs/data-model.md, docs/agents/, README.md; inspect src/ and sdk/ as authoritative evidence.

**Interfaces:** Consume current public types, configuration resolvers and protocol handlers. Produce a bounded findings ledger with document/source paths, evidence and exact corrections.

- [x] Audit public guides and operational configuration against implementation.
- [x] Audit API, workflow, MCP and SDK-facing documentation against exports and handlers.
- [x] Audit internal architecture/data-model/module references against source.
- [x] Review findings, identify historical content and reproduce each actionable mismatch before changing it.

### Task 2: Audit generated routes and reading experience

**Files:** docs/astro.config.mjs, docs/src/content/docs/, docs/src/components/, docs/src/styles/, docs/scripts/validate-discovery.ts; generated docs/dist is ignored evidence.

**Interfaces:** Consume the built HTML graph and existing sitemap/discovery outputs. Produce broken-link/fragment reports and representative desktop/mobile inspection evidence.

- [x] Run the existing docs build and discovery guard, retain complete output.
- [x] Check local links and heading anchors in rendered HTML and internal Markdown references, resolving source imports correctly.
- [x] Inspect home, quickstart, a long guide, API reference and changelog at desktop/mobile widths and both themes.
- [x] Correct only demonstrated content/navigation/rendering issues using the established components and styles.

### Task 3: Apply corrections and prove the result

**Files:** Only the affected documentation/components/checks, their technical reference, changelog and work-state records.

**Interfaces:** Consume reviewed findings; produce corrected docs plus exact validation evidence.

- [x] Apply content corrections in bounded file ownership groups; avoid tests for editorial-only changes.
- [x] For executable tooling/site defects, add a meaningful failing regression before the smallest fix (not triggered: no executable changes).
- [x] Rebuild the site, repeat link/anchor checks, relevant docs tests, release-post/data checks, typecheck, format and startup.
- [x] Run full sandbox/fresh native Ubuntu after any code change; SDK sandbox if sdk/ is modified, model only if its runtime trigger is reached.
- [ ] Obtain whole-change skeptic PASS, perform authorized integration, watch exact-head CI and record the final limitations and coverage.

This checklist records the validated candidate before integration. Fresh native
Ubuntu validation passed; prior sandbox evidence is carried by a proven
documentation-only delta. No new code, model or SDK gate was triggered. Final
approval and integration receipts belong to the work-item evidence and completion
record; no runtime cache-eviction reproduction or fix is claimed here.
