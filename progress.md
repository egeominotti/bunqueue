# Progress

Shared restart notes for every session and worktree. Work items, statuses and
evidence live in [`feature_list.json`](feature_list.json); this file holds what
the next session needs to resume. Edit rules for parallel worktrees: change only
your item's lines in Current State and prepend your Session Log entry. On a
rebase conflict, `**Last Updated:**` takes the newest date and the Session Log
keeps both entries, newest first. Nothing here authorizes a commit, push, version
bump, release or publication; only the user's explicit request does. Harness
overview: [docs/agents/README.md](docs/agents/README.md).

## Current State

**Last Updated:** 2026-11-13
**Active items:** many sessions run at once; the items in progress are the
`in-progress` entries of `feature_list.json`, each with its owning `branch`.

### What's Done

- `issue-189-tls-reload`: `SIGHUP` reloads the TLS certificate without a restart;
  commit `da289219` on `main`, sandbox green, skeptic `PASS`.
- `agent-harness`: `CLAUDE.md`/`AGENTS.md` routing pages, `docs/agents/`, the state
  files, `./init.sh`, the contract tests `test/agent-harness-*.test.ts`, and the
  harness files in the sandbox test image; sandbox green on the final tree.
- `release-2.9.22`: published 2026-11-13 from tag `v2.9.22` at `29428c1c` (GitHub
  release, Docker images, npm `latest` with provenance); release metadata
  refreshed. Evidence in `feature_list.json`.
- `agent-skills`: six cross-client Agent Skills in `.agents/skills/` with
  Claude Code symlinks, their scripts, evaluations and contract tests; sandbox
  green, skeptic `PASS`. Evidence in `feature_list.json`.
- `root-cleanup`: the root `CHANGELOG.md` is a pointer to the docs changelog,
  `MIGRATION_FROM_BULLMQ.md` and `.npmignore` are gone, `.env.example` and the
  plugin's MCP tool count are corrected, `.dockerignore` is documented; sandbox
  green on tree `ddcfaf6f`, skeptic `CONDITIONAL` with docs-only notes, applied.
  Evidence in `feature_list.json`.

### What's In Progress

- Nothing recorded here; see the `in-progress` entries of `feature_list.json`.

### What's Next

1. `issue-189-unix-socket-followups`: reproducing tests first for the two
   unix-socket rollback notes in `src/infrastructure/server/httpListener.ts`, then
   the fix.
2. `agent-harness-followups`: the non-blocking notes of the harness review.
3. `cron-test-midnight-boundary`: `test/cronScheduler.test.ts:819` fails when the
   unit suite crosses 23:59 UTC; reproduce first, then an injected clock or a
   schedule that cannot be under 60 s away.
4. `ci-script-tests-bun-only-machines`: the two CI-script test files that need
   `node` in the Bun-only OrbStack Machines.
5. `ci-python39-runner-pin`: the Python 3.9 SDK job's `ubuntu-24.04` pin.
6. `npm-files-benchmark-negation`: `bun pm pack` ignores the `!dist/benchmark`
   negation of `package.json` `files` (latent: the library build never emits that
   directory); test first, then `!dist/benchmark/**`.
7. `docs-mcp-tool-count-drift`: three docs-site sources and one internal page
   still say 75 MCP tools; the server registers 79.

## Blockers / Risks

- `main` requires pull requests; only an account with bypass rights can push to it
  directly. The release push (CI's version gate tags, releases and publishes from
  `main`) therefore needs an account with write access to `main`, or a pull
  request merged by one.
- The release gates are long: `bun run test:sandbox` took 9.12 min of wall time on
  the last green run, and the SDK sandbox and both OrbStack Machines come on top.

## Decisions Made

- **No `STOPSIGNAL` in the Dockerfile** (issue 189): the images keep declaring no
  stop signal, for release compatibility. Consequence, documented in the TLS guide
  and the changelog: `docker kill -s HUP` counts as a manual stop for the restart
  policy; reload with `docker exec <container> kill -HUP 1` (or `sh -c` on debian
  and slim) or opt in with `--stop-signal SIGTERM` / Compose `stop_signal: SIGTERM`.
- **`SIGHUP` handler only with TLS configured**: without TLS the server installs no
  handler, exactly as in 2.9.21.

## Session Log

Newest first. Prepend one entry per session; for multi-session work fill the
[`session-handoff.md`](session-handoff.md) sections into the entry.

### 2026-11-13 — root-cleanup

- Objective: the owner asked to remove useless or outdated files from the
  repository root (`root-cleanup`, branch `root-cleanup`, base `3e08f75b`, its own
  worktree). Status `done`; staged, not committed.
- Replaced: `CHANGELOG.md` (257,514 bytes, last touched 2026-09-03, stopped at
  2.9.4) is now a nine-line pointer to `docs/src/content/docs/changelog.md`,
  bunqueue.dev/changelog and the GitHub releases page. All 219 `##` sections of
  the old file exist in the docs changelog (which has 41 more: 2.8.33 to 2.8.55
  and 2.9.5 to 2.9.22); 203 are identical apart from punctuation, and 16 are a
  shorter or differently worded account of the same release (`[Unreleased]`,
  2.8.29 to 2.8.32, 2.8.56 to 2.8.61, 2.9.0 to 2.9.4). No version existed only in
  the root file, so no section was migrated; at the skeptic's request the three
  references only the root wording carried moved into the docs changelog: the
  issue links #118 (completed rows unreachable after eviction) and #119
  (resumable first boot after a schema upgrade) in 2.9.3, and the `fast-uri`
  advisory id `GHSA-7p8r-x3mc-p8w7` in 2.8.58, with the two generated release
  posts regenerated. Nothing reads the root file: no script,
  test, workflow, docs generator or link (the SDKs link their own
  `sdk/<language>/CHANGELOG.md`).
- Deleted: `MIGRATION_FROM_BULLMQ.md` (commit `c421d636`, 2026-02-27, a reply
  written for one user's own wrapper API; unreferenced) and `.npmignore`.
  `.npmignore` evidence, in a `git archive` copy built with `bun run build:lib`:
  `bun pm pack --dry-run --ignore-scripts` and
  `npm pack --dry-run --ignore-scripts` (Bun 1.4.4, npm 11.20.0) each list the
  same 1,748 files with and without it, and the two real Bun tarballs are
  byte-identical (sha256 `203673b03298803ab8da...`). With the compiled
  `dist/bunqueue` and a probe `dist/benchmark/` present the lists are again
  identical with and without it, and a `.npmignore` naming `dist/main.js`,
  `DISCLAIMER.md` and `dist/shared/` removes none of them in either tool: a root
  `.npmignore` is not applied next to a `files` list.
- Migration guide: three bullets added to "What stays the same" in
  `docs/src/content/docs/guide/migration.mdx`, each checked against the code: the
  `QueueEvents` payloads and its embedded default (`src/client/events.ts`,
  `src/client/types/events.ts`), the job scheduler methods
  (`src/client/queue/runtime/scheduling.ts`), and `job.log()` /
  `queue.getJobLogs()` with its `[level] message` lines
  (`src/client/queue/operations/management.ts`). Not carried over, because the
  current docs contradict or do not support it: `SandboxedWorker` as the
  equivalent of `processorPath` (the guide calls it experimental and
  thread-based), the memory figures, the event mapping of the user's wrapper,
  and a `QueueEvents` example without `connection` in a TCP setup.
- Fixed facts instead of deleting: `.env.example` (header said `bunQ`;
  `NODE_ENV` has no reader under `src/`; `CORS_ORIGINS` does not exist, the server
  reads `CORS_ALLOW_ORIGIN`; a pointer to the env-vars guide);
  `.claude-plugin/plugin.json` (75 tools) and `agents/bunqueue-assistant.md`
  ("86 registrations, 80 always on") now say 79 primary tools (always registered;
  dynamic mode starts them disabled per toolset), 2 dynamic-discovery
  tools (3 with a decision model) and up to 3 workflow tools, which is what
  `setupTools` registers.
- Kept, with the reason: `.dockerignore` is the ignore file of the
  `examples/postgres-multibroker/client.Dockerfile` build (context `../..`): a
  `FROM scratch` / `COPY . /` probe exports 2,799 files with it and 4,043 without
  it (then `dist`, `data`, `docs`, `.github`, the Markdown files), while the
  `Dockerfile` build exports the same 906 files either way because BuildKit uses
  `Dockerfile.dockerignore`; it gained a header saying so, and
  `docs/features/docker-images.md` explains it. `tsconfig.typedoc.json` and
  `typedoc.json` (`bun run docs:api`), `.mcp.json` (the repository's MCP server
  for Claude Code), `agents/`, `skills/` and `.claude-plugin/` (the plugin),
  `monitoring/` (the `monitoring` profile of `docker-compose.yml`,
  `test/repro-monitoring-production.test.ts`), `.husky/` (the `prepare` script
  sets `core.hooksPath`), `VERSIONING.md`, `GOVERNANCE.md`, `MAINTAINERS.md`,
  `SECURITY.md` and `CONTRIBUTING.md` (current, cross-linked), both compose files
  (untouched: auth settings are out of scope).
- Docs in the same change: the changelog `[Unreleased]` Documentation entry,
  `CONTRIBUTING.md`, `docs/README.md`, `docs/agents/release.md` (what the tarball
  contains), `docs/features/docker-images.md`.
- Gate: `bun run test:sandbox` green on the staged tree `ddcfaf6f`: unit 11746
  pass / 0 fail / 399 skip, tcp 553 / 0, embedded 349 / 0, no anomalies
  (`artifacts/test-sandbox/2026-11-13T01-41-22.807Z/`, in this worktree).
- Skeptic: `CONDITIONAL` on `ddcfaf6f`, three docs-only notes (the #118/#119 links
  and the advisory id above, "always registered" in the agent file, the final
  state), all applied. The only changes after the sandbox run are those lines:
  `docs/src/content/docs/changelog.md`, the generated posts
  `docs/src/content/docs/blog/bunqueue-v2-9-3.md` and `bunqueue-v2-8-58.md`,
  `agents/bunqueue-assistant.md` (one phrase; the file is not in the test image),
  `feature_list.json` and `progress.md`. Skeptic: `PASS` on the final delta.
- Host on the final tree (the wording of the evidence is the only change after
  these runs): `bun test test/docs-*.test.ts test/agent-harness
  test/agent-skills.test.ts` 173 pass / 0 fail (13 files), and with all of
  `test/agent-skills` 221 / 0 (16 files); CI's docs-job test set 324 / 0
  (29 files); the packaging and workflow tests 47 / 0 (4 files, one packs the
  tarball); `generate-release-posts.ts --check` OK (259 posts);
  `bun run check:docs-data` OK; `git diff --cached --check` clean; `./init.sh`
  green (`bun run typecheck` on 902 and 2,106 files, `bun run format:check` on
  2,307 files, contracts 99 / 0).
- Not run: the Astro build of the docs site and its local preview.
  `bun run test:model` and `bun run test:sandbox:sdk` are not triggered (no `src/`
  or `sdk/` change).
- Risk: a link from outside the repository to
  `blob/main/MIGRATION_FROM_BULLMQ.md` or to an anchor of the old `CHANGELOG.md`
  now misses; the history keeps both files (`git show 3e08f75b:<path>`).
- Next: the skeptic on the final delta, then the commit when the user asks. Two
  findings are new `not-started` items: `npm-files-benchmark-negation` and
  `docs-mcp-tool-count-drift`.

### 2026-11-13 — agent-skills

- Objective: cross-client Agent Skills for contributors (`agent-skills`,
  branch `agent-skills`, worktree separate from the release). Six skills in
  `.agents/skills/` (the path Codex, Gemini CLI, Cursor and Copilot read), one
  relative symlink each in `.claude/skills/` for Claude Code, portable
  frontmatter only (`name`, `description`, `license`, `metadata`), trigger and
  output evaluations per skill, and the contract tests
  `test/agent-skills.test.ts` and `test/agent-skills-scripts.test.ts`.
- Sources for the format and practices: agentskills.io (specification, best
  practices, descriptions, scripts, evaluations), the Claude Code skills docs,
  Anthropic's skill authoring best practices, the Codex skills docs, and the
  anthropics/skills and openai/skills skill-creator skills.
- Evidence so far: `bun run test:sandbox` green on the first staged tree
  `4e9adf35` (unit 11720 / 0 / 398, tcp 553 / 0, embedded 349 / 0). On `daf7db88`
  it failed only on `test/cronScheduler.test.ts:819`, which expects the next
  midnight to be more than 60 s away and ran at 23:59:13 UTC (unit 11739 pass /
  1 fail, `artifacts/test-sandbox/2026-11-12T23-56-09.256Z/`): unrelated to the
  skills, recorded as the new item `cron-test-midnight-boundary`.
- Skeptic: `FAIL` on `4e9adf35` (Machines left behind after an interrupt during
  `orb create`, renames hidden from `gate-delta.sh`, cleanup state ignored by the
  verdict, wording, files over 300 lines), fixed: the Machine gate is split into
  `machine-gate.sh`, `machine-worker.sh`, `machine-cleanup.sh` and
  `machine-verdict.sh`. `CONDITIONAL` on `daf7db88` (a create that appears after
  the settle window recorded as deleted; `orb list` piped into `grep -q` under
  pipefail, so an existing name could read as free; reaped worker pids handed to
  cleanup; exit 130 hiding a failed cleanup), fixed, each with a test in
  `test/agent-skills-machine-lifecycle.test.ts` (fake OrbStack) or
  `test/agent-skills-machine-gate.test.ts`.
- Host (diagnostic) on the fixed tree: `bun test test/agent-skills
  test/agent-harness` 99 / 0; typecheck, format and whitespace clean; `./init.sh`
  green.
- Final gate: `bun run test:sandbox` green on the fixed tree `bbd565ca` (unit
  11746 / 0 / 399, tcp 553 / 0, embedded 349 / 0, no anomalies; in the
  agent-skills worktree, `artifacts/test-sandbox/2026-11-13T00-20-42.544Z/`);
  skeptic `PASS` on that tree. Then rebased onto `7bc922db` (the release
  metadata refresh, itself sandbox-gated): the rebase adds only that commit's
  files and merges the changelog and the state files.

### 2026-11-13 — release-2.9.22 (published, step 7)

- Published: tag `v2.9.22` at `29428c1c`; CI run 43327462318 (GitHub release, Docker
  images, SBOM, attestations) and run 43329831287 (npm `bunqueue@2.9.22` as
  `latest`, with provenance).
- Step 7: `generate-release-posts.ts --refresh` rewrote
  `docs/src/data/releaseMeta.json` (259 versions, 190 tagged): new entries for
  2.9.22, 2.9.21 and 2.9.20, and `npm` for 2.9.19. The 2.9.22 post already
  matched the refreshed byline, install box, contributors and footer, so it is
  unchanged; its Release and Commits links answer 200.
- State: item `done`, branch removed; a `## [Unreleased]` changelog section
  records the refresh. Committed with this entry.
- Evidence (host): `generate-release-posts.ts --check` OK (259 posts);
  `check:docs-data` OK; `bun test test/docs-*.test.ts test/agent-harness-*.test.ts`
  144 / 0; `bun run typecheck`, `bun run format:check` and `git diff --check`
  clean; `./init.sh` green.
- Next: commit with the changelog entry after the gates and a skeptic `PASS`; the
  `agent-skills` branch also adds `## [Unreleased]`, to merge at rebase.

### 2026-11-12 — release-2.9.22 (preparation)

- Objective: checklist steps 1-4 of [docs/agents/release.md](docs/agents/release.md),
  at the user's explicit request; status `in-progress`, branch
  `tls-a-renewed-certificate-is-only-served-after-a`, base `18bfc76f`, nothing
  committed.
- Done: `package.json` 2.9.22; `bun run docs:api` (64 files of
  `docs/public/reference/v2.9`); the changelog section dated
  `## [2.9.22] - 2026-11-12`; the 15 Docker image references in `README.md` and
  the deployment, env-vars, installation and server guides, as `2d617fd3` did;
  the hand-written `docs/src/content/docs/blog/bunqueue-v2-9-22.md` (generated
  marker removed). No `sdk/` file changed.
- Decision: TypeDoc 0.28.20 only treats a `.git` directory as a repository, so
  in a worktree (`.git` is a file) `docs:api` dropped every "Defined in" source
  link (259 files changed). The reference was regenerated in a temporary full
  clone of the same tree in the scratchpad and copied back: 64 files, links
  kept (1,712 before, 1,771 after), `diff -r` identical to the clone.
- Evidence (host, diagnostic): `generate-release-posts.ts --check` OK (259
  posts); `bun test test/docs-*.test.ts` 122 / 0; `bun test test/agent-harness`
  22 / 0; version and release tests 74 / 0 (7 files); `check:docs-data` OK;
  `bun run typecheck` and `bun run format:check` clean; `git diff --check`
  clean; `./init.sh` green.
- Gates (exact totals in the `feature_list.json` evidence): `bun run test:sandbox`
  and `bun run test:sandbox:sdk` green on tree `386b8522`; the skeptic then
  required the flow Upgrade notes (docs-only patch, tree `a4146e29`); the
  Ubuntu 24.04 and Debian 13 Machines are green on `a4146e29` except the known
  Bun-only gap of 6 CI-script tests that need `node`
  (`artifacts/machines/20261112T212315Z/manifest.md`), now the
  `ci-script-tests-bun-only-machines` item.
- Next: the push; after publication, `generate-release-posts.ts --refresh` and
  the post's install box and contributors.

### 2026-11-12 — agent-harness

- Built the five-subsystem harness: `CLAUDE.md` (39,046 bytes before) and
  `AGENTS.md` (17,534 bytes before) became routing pages under 12 KiB that keep
  every mandatory rule; the reference sections moved verbatim to `docs/agents/`
  and the test rules to `docs/testing.md#agent-test-rules`; added
  `feature_list.json`, `progress.md`, `session-handoff.md`, `init.sh` and
  `docs/agents/README.md`.
- First skeptic review: `FAIL` (the unit container lacked the harness files, EOF
  blank lines, overclaimed status, a 315-line test file, loose contract checks).
  All fixed in the same uncommitted change; see the evidence below.
- Evidence after the fixes (host only, diagnostic; staged-plus-working tree):
  `bun test test/agent-harness` 22 pass / 0 fail (2 files); `./init.sh` green in
  about 5 s; `bun test test/docs-*.test.ts` 122 / 0;
  `bun test test/sdk-mutation-workflow.test.ts` 1 / 0; `bun run typecheck` and
  `bun run format:check` clean; `git diff --check` and `git diff --cached --check`
  clean; `generate-release-posts.ts --check` OK; course validator 100/100 (32
  before). A simulated test-image layout (`Dockerfile.test` COPY lines over the
  allow-listed context) runs the contract 22 / 0; the pre-fix layout reproduced
  the `ENOENT` failure.
- Second skeptic review: `CONDITIONAL` on the sandbox only. `bun run test:sandbox`
  on the exact staged tree: unit 11668 pass / 0 fail / 398 skip, tcp 553 / 0,
  embedded 349 / 0, no resource anomalies
  (`artifacts/test-sandbox/2026-11-12T20-20-16.500Z/`). `bun run test:model` and
  `bun run test:sandbox:sdk` not triggered (no `src/` or `sdk/` change). The
  remaining minor notes are the `agent-harness-followups` item.
