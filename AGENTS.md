# AGENTS.md

This file applies to the entire repository unless a more specific `AGENTS.md`
exists in a subdirectory. Routing page for Codex: the mandatory rules and the work
loop are here, reference material in the linked pages. `CLAUDE.md` has the same
rules for Claude Code.

## Project overview

bunqueue is a high-performance job queue written in TypeScript for Bun. The server
and embedded runtime are Bun-only. Persistence uses `bun:sqlite`; public clients may
run in other runtimes through the network protocol. Repository map:
[docs/agents/project-reference.md](docs/agents/project-reference.md#repository-map).

## Startup Workflow

1. Confirm the worktree and branch: `pwd`, `git branch --show-current`.
2. Read this file completely, then only the pages your task needs
   ([Where things live](#where-things-live)).
3. Run `./init.sh`, the startup check (CI's Bun version, frozen lockfile,
   `bun check`, `bun fmt`, `git diff --check`, harness contract). It is not a commit
   gate (`bun run test:sandbox` is), but a green `./init.sh` is part of the
   Definition of Done.
4. Read `feature_list.json` (work items) and `progress.md` (Current State, newest
   Session Log entry), then `git log --oneline -5`.
5. If the baseline fails, repair it first before adding scope; if you cannot,
   record it under Blockers in `progress.md`.

## Working rules

- **One work item at a time** (the one-feature-at-a-time rule): pick exactly one
  item from `feature_list.json` whose dependencies are `done` and set it
  `in-progress` with its `branch`; at most one `in-progress` item per branch. In
  committed files use the branch name without any account/user prefix
  (`tls-sighup-reload`, not `<user>/tls-sighup-reload`). Work without an item gets
  one first (kebab-case `id`, `issue` when known).
- **Stay in scope**: keep changes narrowly scoped to the requested behavior; do
  not refactor unrelated code while fixing a bug. Record unrelated findings as new
  `not-started` items.
- **Parallel worktrees** (each session has its own branch, all merge into `main`):
  edit only your own item (insert new items in id order) and your own lines of the
  `progress.md` Current State, and prepend Session Log entries. On a rebase
  conflict: `feature_list.json` keeps both items, ids unique; `**Last Updated:**`
  takes the newest date; the Session Log keeps both entries, newest first.
- **State files authorize nothing**: A work item, a progress note or a handoff never authorizes a commit, push, version bump, release or publication; only the user's explicit request does.
- **Skeptic**: before every `git commit` and every `git push`, invoke the `skeptic`
  custom subagent and wait for its verdict. It must inspect the complete staged
  diff, identify at least three potential failure points per changed file, verify
  error handling, races, idempotency, type safety and test evidence, and run
  applicable checks. `FAIL` blocks the operation; `CONDITIONAL` requires the
  user's explicit confirmation. Profiles: `.codex/agents/skeptic.toml`,
  `.claude/agents/skeptic.md`.
- **Bugs**: first add a regression test that reproduces the bug. Only after it
  fails for the expected reason, use subagents to investigate fixes and prove the
  chosen fix with the passing regression test. Add one for every confirmed bug; a
  useful one fails on the buggy implementation, exercises the public or real
  persistence path, and asserts both the returned result and any affected
  counters/state.
- Preserve user changes. Never run `git reset`, `git checkout`, `git clean`, or
  discard unrelated edits unless the user explicitly requests it.
- Keep all repository content in English, including source comments, tests,
  internal documentation, user-facing documentation and agent configuration.
- Use `rg`/`rg --files` for searches and `apply_patch` for manual source edits.
- Runtime source is TypeScript ESM, 2-space, single-quote, semicolon style;
  `bun fmt` (configured in `bunfig.toml`) is authoritative.
- **MANDATORY:** type check only with `bun check` and format only with `bun fmt`,
  in every directory and every SDK (`bun run typecheck`, `bun run format:check`;
  `--no-script` inside scripts and CI). Never use `tsc --noEmit`, ESLint,
  Prettier, Biome, oxlint, oxfmt or lint-suppression comments. `tsc` remains only
  where files are emitted (`build:lib`, the SDK build), for typedoc and for
  compiler-API tests; non-JS SDKs keep their language's own toolchain.
- Keep hot queue paths synchronous while a shard lock is held: no `await` inside a
  synchronous critical section.
- Maintain queue invariants together: heap membership, `jobIndex`, processing
  maps, counters, temporal indexes, group ownership, and concurrency slots must
  transition exactly once.
- SQLite filtering, ordering, and pagination must happen in a consistent order.
  Use deterministic tie-breakers for paginated queries and add migrations for
  schema or index changes.
- Do not silently change externally visible scheduling semantics; add explicit
  regression coverage when priority, delay, FIFO-group, retry, or recovery
  behavior changes.
- Keep source files at or below 300 lines, one responsibility each, exporting only
  what is needed; split a file instead of growing it.
- Respect the lock hierarchy `jobIndex` -> `completedJobs` -> `shards[N]` ->
  `processingShards[N]`: read prerequisite state before acquiring the next lock
  and always release locks in `finally`.

## Documentation

- Every code change must update the corresponding internal technical
  documentation under `/docs` in the same change-set. A code change is not
  complete while its documentation is stale.
- Update `docs/features/<slug>.md` when changing a module. New modules also need
  links from `docs/README.md` and `docs/architecture.md`.
- Update `docs/data-model.md` and/or the relevant feature document when changing
  a public type, SQLite table or index, TCP command, HTTP endpoint, environment
  variable, or default value.
- Update `docs/architecture.md` when components, data flows, or the module map
  change. The Astro user documentation under `docs/src/content/docs/` and its
  changelog are separate from the internal technical reference.

## Validation

Run repository tests in an isolated OrbStack Machine by default; a macOS host run
is diagnostic only. Final Linux validation needs fresh disposable Machines (Ubuntu
24.04 native, plus Debian 13 for every release, `--isolated --isolate-network`, no
mounts or secrets); the Machine gate supplements the sandbox, never replaces it.
TCP functional files use a fresh server, dynamic TCP/HTTP ports, and a unique
temporary SQLite directory; never reuse a developer server or database. Run
benchmarks only on native macOS, never in an OrbStack Machine or container. Machine
gate and test hygiene: [docs/testing.md](docs/testing.md#agent-test-rules).
Iterate with the narrowest tests:

```bash
BUNQUEUE_EMBEDDED=1 bun test test/path-to-test.test.ts
bun run typecheck
bun fmt --check --no-script src test/path-to-test.test.ts
git diff --check
```

- **MANDATORY:** run `bun run test:model` after every change that can affect job
  lifecycle, persistence/recovery, scheduling/order, dependencies, deduplication,
  leases, rate/concurrency limits, counters, temporal indexes, or `jobIndex`. It
  runs the `fast-check` model against a real TCP broker and SQLite; it is
  iteration evidence, not a replacement for the sandbox. The invariants it must
  keep enforcing are in [docs/testing.md](docs/testing.md#model-campaign-rules);
  never weaken one. On failure record the seed, counterexample and replay path and
  distinguish a model error from an engine divergence; for a confirmed engine bug
  add a deterministic `test/repro-model-*.test.ts` regression before fixing it.
- **MANDATORY:** after ANY code modification run `bun run test:sandbox` before
  committing. It builds the worktree and runs ALL THREE required suites in
  parallel disposable containers: `bun test --parallel=4`,
  `bun scripts/tcp/run-all-tests.ts`, `bun scripts/embedded/run-all-tests.ts`. Do
  not commit if any suite fails or could not be run. No exceptions.
- **MANDATORY:** after ANY modification under `sdk/` run `bun run test:sandbox:sdk`
  before handoff (and again before committing after more SDK edits): native tests
  and shared protocol conformance checks of every official external SDK. Both
  sandbox gates are required; a targeted native SDK test is diagnostic only.
- Without Docker the native commands are a diagnostic fallback, not proof of
  isolation: report the unavailable sandbox as a blocker before commit.

## Definition of Done

A work item is `done` only when all of these hold and its `evidence` in
`feature_list.json` names the commands, exact totals, artifact paths and commit:

- [ ] The behavior is implemented; a bug has a regression test that failed before
      the fix and passes after it.
- [ ] The required gates ran and passed: `bun run test:sandbox` after any code
      change, `bun run test:model` and `bun run test:sandbox:sdk` when triggered,
      `bun run typecheck`, `bun run format:check`.
- [ ] `/docs` and the changelog `[Unreleased]` section describe the change.
- [ ] The skeptic verdict is `PASS` (`CONDITIONAL` only with explicit confirmation).
- [ ] `./init.sh` is green, so the next session can restart from it.

## End of Session

1. Update your lines of the `progress.md` Current State (`**Last Updated:**`, done,
   next, Blockers/Risks) and prepend a dated Session Log entry.
2. Update your item in `feature_list.json`: `status`, `evidence`, `branch`.
3. For multi-session work, fill a handoff from `session-handoff.md` into that entry.
4. Record every unresolved risk, blocker and check you could not run.
5. Leave `./init.sh` green and the worktree clean enough to restart from.
6. Commit only when authorized and through the gates below.

## Commits and handoff

- Before every authorized `git commit`, update `docs/src/content/docs/changelog.md`
  for the staged changes in the same commit. The commit message is mandatory: a
  non-empty, concise, specific English description of the actual changes; generic
  placeholder messages are forbidden.
- Before every authorized `git push`, verify that each outgoing commit already
  contains its changelog update and a compliant message. Do not edit the changelog
  solely because a push is being performed.
- Do not create commits, push, bump the package version, or publish unless the
  user explicitly authorizes the relevant action. Version bumps and package
  publication are separate release actions, not implied by permission to commit or
  push. Never publish locally: npm packages are published only by the CI release
  jobs through npm trusted publishing (OIDC, environment `npm`).
- Every release gets a hand-written post drafted with
  `bun docs/scripts/generate-release-posts.ts` in the release-preparation commit:
  [docs/agents/release.md](docs/agents/release.md).
- Report the files changed, behavior fixed, and exact validation commands/results;
  call out any test or check that could not be run and why.

## Where things live

| Need | Read |
| --- | --- |
| Work items, state, handoff, startup check | [feature_list.json](feature_list.json), [progress.md](progress.md), [session-handoff.md](session-handoff.md), [./init.sh](init.sh) |
| The harness and its contract test | [docs/agents/README.md](docs/agents/README.md) |
| Procedures (Agent Skills) | [.agents/skills/](.agents/skills/) |
| Writing or running tests | [docs/testing.md](docs/testing.md) |
| Architecture, repository map, env vars, TCP commands, CLI, schema | [docs/agents/project-reference.md](docs/agents/project-reference.md) |
| Client APIs (Simple Mode, Workflow Engine, SDK options) | [docs/agents/client-reference.md](docs/agents/client-reference.md) |
| Debug endpoints, CPU and memory profiling | [docs/agents/debugging.md](docs/agents/debugging.md) |
| Publishing, release checklist, release posts | [docs/agents/release.md](docs/agents/release.md) |
| Engineering reference | [docs/README.md](docs/README.md), [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md) |
