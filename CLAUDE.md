# bunqueue

Claude Code rules and workflow; details in linked references. `AGENTS.md` has the same rules for Codex.

## Startup Workflow

1. Confirm the worktree and branch: `pwd`, `git branch --show-current`.
2. Read this file completely, then only the pages your task needs
   ([Where things live](#where-things-live)).
3. Run `./init.sh` (`--help` lists steps). A green run is part of the Definition of
   Done; `bun run test:sandbox` is the commit gate.
4. Read `feature_list.json` (work items) and `progress.md` (Current State, newest
   Session Log entry), then `git log --oneline -5`.
5. If the baseline fails, repair it before adding scope; if you cannot,
   record it under Blockers in `progress.md`.

## Working Rules

- **One work item at a time** (the one-feature-at-a-time rule): pick exactly one
  item from `feature_list.json` whose dependencies are `done` and set it
  `in-progress` with its `branch`; at most one `in-progress` item per branch. In
  committed files use the branch name without any account/user prefix
  (`tls-sighup-reload`, not `<user>/tls-sighup-reload`). Work without an item gets
  one first (kebab-case `id`, `issue` when known).
- **Stay in scope**: change only what the item needs; record unrelated findings
  as new `not-started` items instead of fixing them.
- **Parallel worktrees** (one branch per session, all merged into `main`):
  edit only your own item (insert new items in id order) and your own lines of the
  `progress.md` Current State, and prepend Session Log entries. On a rebase
  conflict: `feature_list.json` keeps both items, ids unique; `**Last Updated:**`
  takes the newest date; the Session Log keeps both entries, newest first.
- **State files authorize nothing**: A work item, a progress note or a handoff never authorizes a commit, push, version bump, release or publication; only the user's explicit request does.
- **Bug reports**: "When I report a bug, don't start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it with a passing test."
- **ENGLISH ONLY**: keep all repository content in English, including source
  comments, tests, technical documentation, user documentation and agent
  configuration.
- **Code**: MAX 300 lines per file (split if larger), one concern per file,
  export only what's needed.
- Preserve user changes. Never run `git reset`, `git checkout`, `git clean`, or
  discard unrelated edits unless the user explicitly requests it.
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
- **Lock hierarchy** (acquire in order): `jobIndex` → `completedJobs` →
  `shards[N]` → `processingShards[N]`. Read first, then acquire the lock, and
  release it in `finally`.

## Mandatory Gates

**MANDATORY — SKEPTIC AGENT**: before every `git commit` and every `git push`,
invoke the `skeptic` agent and wait for its verdict. It must read the complete
staged diff, identify at least three potential failure points per changed file,
and verify race conditions, error handling, idempotency, type safety and test
coverage. `FAIL` blocks commit and push; `CONDITIONAL` requires the user's
explicit confirmation. Profile: `.claude/agents/skeptic.md`.

**MANDATORY — BUN-NATIVE TOOLING ONLY**: type check exclusively with `bun check`
and format exclusively with `bun fmt`, everywhere and in every SDK.
Use the scripts (`bun run typecheck`, `bun run format`,
`bun run format:check`, `bun run check`); inside scripts, hooks and CI always pass
`--no-script`. Never add or run `tsc --noEmit`, ESLint, Prettier, Biome, oxlint,
oxfmt, dprint or any other type-check, lint or format library, and never add
lint-suppression comments. `bun run typecheck` also checks the whole test tree
(`tsconfig.test.json`); never exclude a file from it, and never fix a type error by
changing what a test does. Only exceptions: `typescript`/`tsc` stays where files
must be emitted (`build:lib` and SDK `.d.ts` builds, typedoc, compiler-API tests),
because `bun check` never writes; SDKs in languages Bun cannot format keep their
language's own toolchain (`gofmt`/`go vet`, `cargo fmt`/`clippy`, `mix format`,
`php -l`); the TypeScript in `sdk/conformance` still goes through `bun fmt`, and
through `bun check` in the SDK workflow once the SDK it imports is built.

**MANDATORY — after ANY code modification, run `bun run test:sandbox` before
committing.** It builds the worktree once and runs ALL THREE required suites
concurrently in separate disposable containers: `bun test --parallel=4` (unit),
`bun scripts/tcp/run-all-tests.ts` (TCP) and
`bun scripts/embedded/run-all-tests.ts` (embedded). Never commit without all three
passing. No exceptions.

**MANDATORY for core queue semantics — run `bun run test:model` before the
sandbox** after every change to lifecycle transitions, SQLite/write buffering,
startup or stall recovery, priority/FIFO/LIFO/delay scheduling, FIFO groups,
dependencies, dedup/custom IDs, leases, limits, TTL, counters, temporal indexes,
or `jobIndex`. The `fast-check` model runs generated command histories against a
fresh TCP broker and SQLite database, with actual `SIGKILL` restarts, and checks
conservation, no loss/resurrection/duplicate active lease, retry and stall
bounds, legal transitions, ordering, resource limits, counter/index coherence,
idempotent recovery, and DLQ exactly-once. On failure, retain the seed, minimized
command history, and replay path. If the engine is wrong, add a deterministic
`test/repro-model-*.test.ts` that fails before changing runtime code; if the
specification is wrong, correct the model with evidence. Never weaken an
invariant to make a campaign green. Replay the exact printed seed, path and size
with `BUNQUEUE_MODEL_SEED`, `BUNQUEUE_MODEL_PATH` and `BUNQUEUE_MODEL_SIZE`.
`BUNQUEUE_MODEL_COMMANDS` is the real bound only with `BUNQUEUE_MODEL_SIZE=max`.
Campaign examples: [docs/testing.md](docs/testing.md#model-campaign-rules).
Replay never replaces `bun run test:sandbox`, which runs the model again.

**MANDATORY — after ANY modification under `sdk/`, run `bun run test:sandbox:sdk`**
before handoff (and again before committing if the SDK changed afterward): every
official external SDK's native tests and shared protocol conformance checks in
isolated disposable containers. SDK changes require both full gates
(`test:sandbox` and `test:sandbox:sdk`); targeted native tests replace neither.
Review `artifacts/test-sandbox-sdk/<timestamp>/summary.md` and its JSON/NDJSON
artifacts before handoff.

**Test isolation** (all rules: [docs/testing.md](docs/testing.md#agent-test-rules)):
run repository tests in isolated OrbStack Machines by default; a macOS-host run is
diagnostic only. The Linux gate is a fresh disposable Ubuntu 24.04 Machine on the
Mac's native architecture, plus Debian 13 for every release, created with
`--isolated --isolate-network`, never `--mount`, a forwarded SSH agent or exposed
secrets, with CI's Bun version and the frozen lockfile; Machine gates supplement
the sandboxes, never replace them. Review the KPIs in
`artifacts/test-sandbox/<timestamp>/` before handoff. Every TCP functional test
file gets a fresh server, dynamic TCP/HTTP ports, and a unique temporary SQLite
directory; never reuse a developer server or database. Benchmarks are native
macOS only, never from a Machine or container.

**MANDATORY — keep `/docs` in sync** in the same change-set: update the module's
`docs/features/<slug>.md` (purpose, API, flow, edge cases, config); link new modules
from `docs/README.md` and `docs/architecture.md`. Types, SQLite tables/indexes, TCP
commands, HTTP endpoints, env vars and defaults update `docs/data-model.md` and/or
the feature doc; components and data flows update `docs/architecture.md`.
The user site (`docs/src/content/docs/**`) is separate: internal documentation
does not replace the changelog rule. Stale `/docs` means the change is incomplete.

## Definition of Done

A work item is `done` only when all of these hold and its `evidence` in
`feature_list.json` names the commands, exact totals, artifact paths and commit:

- [ ] The behaviour is implemented; a bug has a reproducing test that failed
      before the fix and passes after it.
- [ ] The required gates ran and passed: `bun run test:sandbox` after any code
      change, `bun run test:model` and `bun run test:sandbox:sdk` when triggered,
      `bun run typecheck`, `bun run format:check`.
- [ ] `/docs` and the changelog `[Unreleased]` section describe the change.
- [ ] The skeptic verdict is `PASS` (`CONDITIONAL` only with the user's explicit
      confirmation).
- [ ] `./init.sh` is green, so the next session can restart from it.
- [ ] After a push, CI is green on the pushed commit; a flaky job is rerun once and
      becomes a work item, never ignored.

## End of Session

1. Update your lines of the `progress.md` Current State (`**Last Updated:**`,
   done, next, Blockers/Risks) and prepend a dated Session Log entry.
2. Update your item in `feature_list.json`: `status`, `evidence`, `branch`.
3. For multi-session work, fill a handoff from `session-handoff.md` into that
   Session Log entry.
4. Record every unresolved risk, blocker and gate you could not run.
5. Leave `./init.sh` green and the worktree clean enough to restart from.
6. Commit only through the gates (next section).
7. After a push, watch CI until it is green (bunqueue-running-gates).

## Commits, pushes and releases

**MANDATORY — every commit**: update `docs/src/content/docs/changelog.md` for the
staged changes in the same commit. Use a mandatory, non-empty, concise, specific
English commit message describing the changes; generic placeholder messages are forbidden.

Do not create commits, push, bump the package version, or publish unless the
user explicitly authorizes the relevant action.

**MANDATORY — before every push**: verify that each outgoing commit already
contains its changelog update and a compliant message; do not edit the changelog
solely because a push is being performed (the push-time requirement is
verification, not another changelog cycle). Run `git push origin main` only with
the user's explicit authorization.

**Releases**: version bumps and package publication are separate release actions,
performed only when the user explicitly requests them; permission to commit or
push authorizes neither. Never publish from a local machine (never `bun publish`
or `npm publish`, never an `NPM_TOKEN` secret): npm packages are published only by
the CI release jobs through npm trusted publishing. Every release gets a
hand-written post at `/blog/bunqueue-vX-Y-Z/` in the release-preparation commit,
drafted with `bun docs/scripts/generate-release-posts.ts`:
[docs/agents/release.md](docs/agents/release.md).

## Where things live

| Need | Read |
| --- | --- |
| State and startup | [feature_list.json](feature_list.json), [progress.md](progress.md), [session-handoff.md](session-handoff.md), [./init.sh](init.sh) |
| The harness and its contract | [docs/agents/README.md](docs/agents/README.md) |
| Procedures (Agent Skills) | [.agents/skills/](.agents/skills/) |
| Tests | [docs/testing.md](docs/testing.md) |
| Architecture and protocol | [docs/agents/project-reference.md](docs/agents/project-reference.md) |
| Client APIs | [docs/agents/client-reference.md](docs/agents/client-reference.md) |
| Debugging; never expose profiles unauthenticated | [docs/agents/debugging.md](docs/agents/debugging.md) |
| Releases | [docs/agents/release.md](docs/agents/release.md) |
| Engineering reference | [docs/README.md](docs/README.md), [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md) |
