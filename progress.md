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
- `agent-harness-followups`: every review note is addressed by
  `harness-production-grade` (same change-set); it has no gate of its own.
- `harness-production-grade`: CI is part of done (routing pages,
  `bunqueue-running-gates`, `scripts/ci-watch.sh`, release verification), the
  `bunqueue-working-autonomously` skill, the harness follow-ups, a faster
  `./init.sh`, the Machine gate fixes from its first real OrbStack run, and the
  trigger-eval runner; sandbox green on tree `a0628e56`, skeptic `PASS`. Evidence
  in `feature_list.json`.

### What's In Progress

- Nothing recorded here; see the `in-progress` entries of `feature_list.json`.
- `drop-postgres-15`: the PostgreSQL 15 CI leg is removed and every current
  support statement says PostgreSQL 16–18 (15 no longer tested, minimum
  supported 16, runtime unchanged); working tree only, evidence `PARTIAL`. Next:
  `bun run test:sandbox`, the skeptic, then the commit the user asks for and its
  CI run.
- `issue-189-unix-socket-followups` (branch `issue-189-unix-socket-followups`):
  reproducing test, fix, docs and changelog in the worktree, not committed;
  `bun run test:sandbox` and the skeptic are still to run.
- `dead-code-sweep` (branch `small-followups`; `npm-files-benchmark-negation` and
  `docs-mcp-tool-count-drift` are folded into it and marked done): implemented and
  staged, not committed; `bun run test:sandbox` and a skeptic `PASS` are still owed.

### What's Next

1. `issue-189-unix-socket-followups`: run `bun run test:sandbox` on the staged
   tree, then the skeptic; the test, fix, docs and changelog are written.
2. `cron-test-midnight-boundary`: `test/cronScheduler.test.ts:819` fails when the
   unit suite crosses 23:59 UTC; reproduce first, then an injected clock or a
   schedule that cannot be under 60 s away.
1. `issue-189-unix-socket-followups`: reproducing tests first for the two
   unix-socket rollback notes in `src/infrastructure/server/httpListener.ts`, then
   the fix.
2. `cron-test-midnight-boundary` (in progress on branch
   `cron-test-midnight-boundary`): reproduced with a pinned clock and fixed in the
   test (`setSystemTime` at noon and 23:59:30, exact next midnight); next:
   `bun run test:sandbox`, skeptic.
3. `postgres-lifecycle-race-flake`: `test/postgres-queue-lifecycle-races.test.ts`
   ("serializes set-based batch admission after obliterate") failed once on
   PostgreSQL 16.x in CI run 43336453775, attempt 1, and passed on the rerun;
   reproduce first with a stress loop against PostgreSQL 16.
4. `ci-script-tests-bun-only-machines`: the two CI-script test files that need
   `node` in the Bun-only OrbStack Machines.
5. `ci-python39-runner-pin` (in progress, branch `drop-python-39`): the Python
   SDK's minimum is now Python 3.10 and the `ubuntu-24.04` pin is gone; the
   change is uncommitted and `bun run test:sandbox`, `bun run test:sandbox:sdk`
   and the skeptic are still to run. The next Python SDK release must carry the
   break.
4. `ci-script-tests-bun-only-machines` (in progress, PARTIAL): the two CI-script
   test files link their own `node` to Bun and pass with `node` absent; the
   Machine gate's known-gap machinery (exit 3) is removed. Next: `bun run
   test:sandbox`, skeptic, commit.
5. `ci-python39-runner-pin`: the Python 3.9 SDK job's `ubuntu-24.04` pin.
6. `dead-code-sweep` on `small-followups` (with the two folded follow-ups): the
   sandbox gate, a skeptic `PASS` and the commit are owed.
7. `deprecated-public-apis-next-major`: the deprecated public APIs kept for
   compatibility, to decide on before a major version.
8. `machine-gate-real-rerun`: run `machine-gate.sh` on real OrbStack again; the
   cleanup, delete-retry and time-bound fixes have run against fakes only.
9. `postgres-sigkill-hook-timeout-flake`: in `test/postgres-public-api-extreme.test.ts`
   a hook timed out after the SIGKILL recovery test on PostgreSQL 17.x (CI run
   43355036181, attempt 1; green on the rerun); reproduce first with a stress loop.
10. `postgres-tests-never-run`: four PostgreSQL regression files skip without
    `BUNQUEUE_TEST_POSTGRES_URL` and are outside `scripts/test-postgres.ts`'s
    `test/postgres-*.test.ts` selection, so they never run; rename or widen.
11. `sandboxed-worker-missing-cases`: three SandboxedWorker cases (draining
    `stop()`, unique wrapper names, `on()`/`once()` chaining) lost with the
    commented-out files `test-suite-pruning` deleted; write them as live tests.
12. `test-suite-speedups`: fixed sleeps on the 5 s stall sweep and the 60 s DLQ
    maintenance in the slowest unit files (estimated 150 s of unit wall time);
    needs a stall/DLQ configuration seam in `getSharedManager()`.

## Blockers / Risks

- `main` requires pull requests; only an account with bypass rights can push to it
  directly. The release push (CI's version gate tags, releases and publishes from
  `main`) therefore needs an account with write access to `main`, or a pull
  request merged by one.
- The release gates are long: `bun run test:sandbox` took 9.12 min of wall time on
  the last green run, and the SDK sandbox and both OrbStack Machines come on top.
- `harness-production-grade`: `CLAUDE.md` and `AGENTS.md` are 71 and 52 bytes under
  the 12,288-byte budget after the CI rule; the next rule added to them needs more
  non-rule prose moved out first. `scripts/ci-watch.sh` has watched one live run
  (43355036181: FAILED, then FLAKY after a rerun), but not yet one waiting for the
  `npm` environment approval (that status is handled from GitHub's documentation,
  not from an observed run). The Machine gate fixes
  (detached cleanup, repeated delete, 15-minute bounds) are proven with a fake
  OrbStack only; the real run predates them.
- `ci-script-tests-bun-only-machines`: the fix is proven on the macOS host with
  `node` absent from `PATH`, not yet in a real OrbStack Machine; the next
  `machine-gate-real-rerun` should exit 0, and any unit failure there is now a real
  failure (exit 3 is retired). On hosts with a real Node (CI) these two files now run
  the gate's `node -p` calls with Bun too; CI's own version-gate job still uses Node.
- `--isolate-network` does not isolate an OrbStack Machine from sibling Machines,
  the Mac's LAN address or the internet (measured on OrbStack 2.2.5). Only the
  sandbox containers run tests without a network.

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

### 2026-11-13 — drop-postgres-15

- Owner decision: remove the PostgreSQL 15 tests (branch `drop-postgres-15`, base
  `bfa290c7`, rebased onto `547e0cc0`).
- Facts found: the only PostgreSQL 15 test surface was the `15.x` entry of the
  `test-postgres` matrix in `.github/workflows/ci.yml`; `quality-gate` needs the
  matrix job as a whole, so no gate list changes. The tests take the expected
  version from `BUNQUEUE_TEST_POSTGRES_VERSION_PREFIX` (default `18.6`) and carry
  no version list. `src/` never reads the server version: no minimum-version
  check, no branch for a server major, so no runtime code changed and nothing
  rejects PostgreSQL 15.
- Changed: the matrix entry; the benchmark runner default
  (`bench/postgres-versions/config.ts`, now `16,17,18`); every current
  "PostgreSQL 15–18" statement (README, `package.json` description, `docs/`, the
  guides, `llms.txt`, `llms-full`, the site description, two regenerated OG
  covers) to 16–18 with "PostgreSQL 15 is no longer tested; the minimum
  supported version is 16"; changelog `[Unreleased]` Upgrade note and Testing
  entry.
- Left on purpose: the 2026-08-26 and 2026-09-03 benchmark reports, their raw
  artifacts and the links that quote their titles (they measured 15.19),
  released changelog entries with the generated 2.9.0 post, and the CI-run
  provenance comment in `test/postgres-process-port-conflict.test.ts`.
- Checks on the host: 7 workflows parse; 14 workflow-reading test files 94 pass /
  0 fail; harness, skills and docs tests 190 pass / 0 fail; typecheck,
  `format:check`, `git diff --check`, release-post check (259) and `./init.sh`
  green.
- Gates: `bun run test:sandbox` green on tree `e7408621` (unit 11787 / 0 / 402,
  tcp 553 / 0, embedded 349 / 0); skeptic `PASS`. Still open: CI on the pushed
  commit, the only run of the PostgreSQL 16, 17 and 18.6 legs (no local
  `bun run test:postgres`). The `package.json` description changes with the
  next release only; no version bump here.

### 2026-11-13 — ci-python39-runner-pin

- Branch `drop-python-39`, base `bfa290c7`, uncommitted. The user decided to drop
  Python 3.9 from the Python SDK. `sdk/python/pyproject.toml` declares
  `requires-python >=3.10`, loses the 3.9 classifier and the `python_version`
  markers of the `test` and `mutation` extras; the SDK version stays 0.2.1.
- `.github/workflows/sdk.yml`: Python legs 3.10 and 3.13, both on
  `ubuntu-latest`; the Hypothesis step runs on both. The public
  `actions/python-versions` manifest has Ubuntu 26.04 x64 builds for 3.10.22 and
  3.13.18 and none for 3.9.
- `test/sdk-python-matrix.test.ts` replaces
  `test/repro-ci-python39-runner.test.ts`: the oldest leg is read from
  `requires-python`, every leg names its runner, the newest is on
  `ubuntu-latest`.
- Docs: root `README.md`, the site's SDK guide, `docs/features/polyglot-sdks.md`,
  the SDK's `README.md`, `AGENTS.md`, `CLAUDE.md`, `INVARIANTS.md` and
  `CHANGELOG.md`, and the changelog's `[Unreleased]` Upgrade notes.
- Host checks are in the item's evidence (`PARTIAL`). Not run:
  `bun run test:sandbox`, `bun run test:sandbox:sdk`, skeptic, CI.
- Risks: Python 3.10 was not run locally, so CI's 3.10 leg is its first run.
  Python 3.10 itself reached end-of-life in October 2026; the same runner
  problem will return when an image drops its build. The next Python SDK
  release must carry the break.
- Left as is: `from __future__ import annotations` and `typing.Optional` /
  `typing.Union` in the SDK (valid on 3.10+, removing them is a refactor), and
  the historical mentions of Python 3.9 in released changelog sections, release
  posts, `bunqueue-running-gates`, `test/agent-skills-ci-watch.test.ts` and an
  eval prompt of `bunqueue-working-autonomously`.
### 2026-11-13 — issue-189-unix-socket-followups

- Branch `issue-189-unix-socket-followups`, base `bfa290c7`, staged, not committed.
- Seam: `createHttpListener` takes an optional `SocketFileSystem` (the restore's
  `statSync`/`chownSync`/`chmodSync`, default `node:fs`), so the owner and failure
  paths run without root.
- `test/repro-issue-189-unix-socket-restore.test.ts` failed on the seam-only tree
  for the right reason: after an injected `chown` `EIO` the rollback left the
  socket at mode `0o755` instead of the operator's `0o660` (2 pass, 1 fail). The
  two warning-path tests (owner not restored on `EPERM`, rollback permissions not
  restored on a `chmod` `EIO`) passed there and fail when their warning, or the
  best-effort rollback, is mutated out.
- Fix: on the rollback rebind any `chown` failure keeps the owner with the owner
  warning and the mode is still applied; the new-pair restore stays strict.
  `docs/features/security-tls-auth.md` and the changelog `[Unreleased]` updated.
- Host checks: `bun test test/repro-issue-189*` 16 / 0, `bun run typecheck`,
  `bun run format:check`, `git diff --check`, `./init.sh` green. Not run:
  `bun run test:sandbox`, skeptic.
### 2026-11-13 — ci-script-tests-bun-only-machines

- Item `ci-script-tests-bun-only-machines` (branch of the same name, base
  `bfa290c7`), `in-progress`, evidence `PARTIAL`; staged, not committed.
- Reproduced on the host with `node` absent from `PATH` (`PATH=<bun link>:/usr/bin:/bin`):
  the two files 16 pass / 6 fail, the six former known-gap titles, `node: command
  not found`; three negative tests in them passed only because the step died at
  `node -p`. Fix in the tests only: each file symlinks `node` to `process.execPath`
  in the temporary directory it already prepends to the spawned bash's `PATH`.
  After: 22 / 0 with and without `node`. New regression test
  `test/repro-ci-script-tests-without-node.test.ts` (node shadowed by an exit-127
  stub): failed before the fix (nested run 16 / 6), passes after.
- Removed the Machine gate's known-gap machinery, which nothing else used:
  `assets/known-node-gap.txt`, the `gap-asis`/`gap-shim` reruns and `--gap-file` of
  `machine-steps.sh`, the gap classification and exit 3 of `machine-verdict.sh`
  (exit 3 documented as retired; `--classify` reads an older exit-3 run as 1),
  the worker's copy of the asset; SKILL.md, manual procedure, evals, the fixture
  tests, `docs/testing.md`, `docs/agents/README.md` and the changelog updated.
  `docs/agents/skill-evals.md` keeps its historical measurement unchanged.
- Host checks: `bun test test/agent-skills test/agent-harness` 136 / 0, typecheck
  and format clean, `git diff --check` clean, `./init.sh` green. Not run: `bun run
  test:sandbox` (left to the parent session), skeptic, a real Machine run.
### 2026-11-13 — cron-test-midnight-boundary

- Test only (branch `cron-test-midnight-boundary`, base `bfa290c7`, staged, not
  committed). Cause: "cron with both schedule and repeatEvery uses schedule for
  nextRun" read the real clock and required the next midnight of `0 0 * * *`
  (local time) to be more than 60 s away. The unchanged assertion with the clock
  pinned by `setSystemTime` (TZ=UTC) fails at 23:59:13 and 23:59:30 and passes at
  noon. The scheduler is correct.
- Fix: the test pins noon and 23:59:30 local time and asserts the exact next
  midnight (and not now + `repeatEvery`). Docs: `docs/testing.md` test hygiene,
  changelog `[Unreleased]` Testing.
- Host checks (diagnostic): the file `--rerun-each 20` 980 / 0, TZ=UTC
  `--rerun-each 5` 245 / 0, typecheck and format:check clean, `git diff --check`
### 2026-11-13 — wait-hold-routing-flake

- Test only (branch `wait-hold-routing-flake`, base `bfa290c7`, staged, not
  committed). Cause: the test asserted 100 Worker `completed` events the moment the
  last `waitUntilFinished` resolved, but the broker wakes a held `WaitJob` while it
  applies the worker's `ACKB` and the Worker emits `completed` only after the
  `ACKB` reply arrives, so the waits can win by one or two ACK batches of 10.
- Reproduction on the host: unchanged test 1 / 30 failed at ambient load, 2 / 40
  with 18 extra busy loops (received 90). A diagnostic copy found the count short
  in 3 / 40 runs and all 100 events in 40 / 40, about 0.1 ms late: nothing is lost.
- Fix: wait up to 5 s for all 100 events, then the same assertions (100 events,
  p90 under 400 ms). Docs: `docs/features/client-queue-sdk.md`, changelog
  `[Unreleased]` Testing.
- Host checks (diagnostic): fixed test 50 / 50 under the same load, whole file
  `--rerun-each 5` 20 / 0, typecheck and format:check clean, `git diff --check`
  clean, `./init.sh` green. Not run: `bun run test:sandbox`, skeptic.
### 2026-11-13 — dead-code-sweep (with two small follow-ups)

- Branch `small-followups`, base `bfa290c7`, staged with `git add -A`, not
  committed. The owner asked to remove useless and deprecated things without any
  business-logic or public-API change: deprecated public APIs are listed in the
  new `not-started` item `deprecated-public-apis-next-major`, not removed.
- `npm-files-benchmark-negation`: `!dist/benchmark/**` in `package.json` `files`;
  `test/package-files-pack.test.ts` failed before (Bun packed 3 probe files under
  `dist/benchmark/`) and passes after.
- `docs-mcp-tool-count-drift`: 75 -> 79 in the two components, `og-covers.ts` and
  `documentation-tooling.md`; `og/integrations.png` and `og/use-cases.png`
  regenerated (the generator reproduces the committed covers byte for byte from the
  old text, so only those two changed); `test/docs-mcp-tool-count.test.ts` derives
  79 from `TOOL_POLICIES`.
- `dead-code-sweep`: 12 unreachable `src/` modules, 17 unused functions, methods
  and types, 3 demo scripts and the `elysia` devDependency removed; the evidence
  and the full list are in the item.
- Skeptic round 1: `FAIL` on one item: `Shard.queueState` is public through
  `QueueManager.getShards()`. Restored byte for byte with `getStateMap()` and its
  test, and listed in `deprecated-public-apis-next-major`. A TypeScript-checker walk
  of the public type surface found no other removed member reachable.
- Host checks: typecheck, format, docs data, release posts, client parity,
  `git diff --check` and `./init.sh` green; the touched areas 607 / 0; docs and
  harness tests 192 / 0; `bun run test:model` 12 / 0 (triggered: dependency-completion
  and DLQ files changed, by deleting unused code only); the full unit suite on the
  macOS host 11,933 pass / 388 skip / 1 fail, `test/mcp-doctor.test.ts` failing at
  its own setup because macOS `bun:sqlite` keeps `-wal`/`-shm` files after close
  (unrelated, reproduced outside the repository).
- Owed: `bun run test:sandbox`, the PostgreSQL suite (only unused exports removed
  from four PostgreSQL modules), the skeptic, the commit. Not run: the Astro build
  of the docs site.
### 2026-11-13 — test-suite-pruning

- Owner request: delete useless tests (`test-suite-pruning`, branch
  `test-suite-pruning`, base `bfa290c7`, staged, not committed; status
  `in-progress`). Every deletion re-verified against a covering test on the same
  code path with equal or stronger assertions; nothing in `src/` changes.
- Deleted 8 files: the 5 SandboxedWorker files that were entirely inside `/* */`
  (they transpile to nothing), `test/bug-unregister-worker-field.test.ts`,
  `test/repro-delayed-error-zero-max-delay.test.ts`, `test/client-pipelining.test.ts`
  (embedded only under the preload; its 500-distinct-ids check moved into
  `test/server-pipelining.test.ts`). Removed 49 tests from 21 files (46 duplicates,
  2 JavaScript-semantics tests, 1 `expect(true)`); the no-op `length >= 0` in
  `test/docs-dlq-guide/configuration.test.ts` now waits for the entry to be
  reported expired. Kept, with reasons, in the item evidence and the report:
  the `validateConfig` tests of `s3Backup-bugs`, the size-mismatch restore test,
  the WAL write-lock test, the concurrent-chain and flow-race tests, the
  writer-exclusion RWLock test.
- New items: `postgres-tests-never-run`, `sandboxed-worker-missing-cases`,
  `test-suite-speedups`.
- Host checks: affected + covering files 743 / 0 before, 684 / 0 after; harness,
  skills and docs tests 190 / 0; typecheck, format check, `git diff --check`,
  `./init.sh` green. Blockers before `done`: `bun run test:sandbox`, the skeptic
  verdict and the commit have not run.

### 2026-11-13 — ci-flakes-record

- State and docs only (branch `ci-flakes-record`, base `e1cbfc99`, staged, not
  committed). `ci-watch.sh --sha` watched its first live run, CI run 43355036181 on
  `e1cbfc99`: FAILED on attempt 1 (PostgreSQL 17.x Integration Tests, 499 pass /
  1 fail: a `beforeEach/afterEach` hook timed out after 5000.37 ms, once the
  SIGKILL recovery test of `test/postgres-public-api-extreme.test.ts` had passed),
  then FLAKY after one `gh run rerun --failed`. CI is green on `e1cbfc99`.
- The flake is the new item `postgres-sigkill-hook-timeout-flake`; it is a different
  file and cause from `postgres-lifecycle-race-flake`, so the two stay separate.
- The `harness-production-grade` evidence is corrected in three places: what tree
  `a0628e56` was, that the skeptic's second note was corrected against `sdk.yml`
  rather than applied as written, and the live `ci-watch.sh` run.
- Checks (host): `bun test test/agent-harness test/agent-skills.test.ts` 68 / 0,
  `generate-release-posts.ts --check` OK, `./init.sh` green; `bun run test:sandbox`
  on this state and docs change before the commit. Its first run failed on one
  unrelated test (`test/repro-wait-hold-routing.test.ts`, 80 of 100 completions),
  recorded as `wait-hold-routing-flake`; the gate was run again.

### 2026-11-13 — harness-production-grade

- Objective: make the harness hold in production (`harness-production-grade`,
  branch `harness-production-grade`, started on `3e08f75b`, rebased onto
  `2e1bf4a7`). Status `done`; lands in the commit that adds this entry.
- CI is part of done: the Definition of Done and End of Session of `CLAUDE.md` and
  `AGENTS.md` (12,217 and 12,236 of 12,288 bytes; the room came from non-rule
  prose only) and the contract's invariant lists; "After the push: watch CI" in
  `bunqueue-running-gates` with `scripts/ci-watch.sh` (exit 0 green, 1 failed,
  3 green only after a rerun, 4 no verdict); release verification and the npm
  `workflow_dispatch` run in `bunqueue-releasing` and `docs/agents/release.md`.
- Decision: `ci-watch.sh` calls a run flaky only on proof, a job that failed in
  an earlier attempt of the same commit and passed in the latest. It does not
  guess from one attempt or from green sibling matrix legs: the Python 3.9 job
  that failed on three pushes in a row (runs 43291604726, 43301509664 and
  43324514568) was one red leg among green ones and was not a flake.
- New skill `bunqueue-working-autonomously` (explicit request only; Codex implicit
  invocation off; adds no authorization), its evaluations and its symlink; routed
  from `bunqueue-dev` and `docs/agents/README.md`.
- Follow-ups (`agent-harness-followups`, now `done`): `./init.sh` Git detection
  by `git rev-parse --show-prefix` and `./init.sh --workspace`; the fast contract
  in `./init.sh` (8 to 10 s, was about 32 s; the Machine lifecycle and worker tests stay in the unit
  suite); the multi-line `COPY` reader; the double-backtick inline-code stripper;
  the `done` evidence heuristic; the branch-name suffix convention, in
  `docs/agents/README.md` and `bunqueue-working-sessions` because the routing pages
  have no bytes for it. New item `postgres-lifecycle-race-flake`.
- Reproduced first: under bash 3.2, with the old `pwd -P` comparison, the
  differently cased path test of `test/agent-harness-init.test.ts` fails (4 pass /
  1 fail); with the new detection it passes.
- Machine gate, after its first real run (`3e08f75b`, OrbStack 2.2.5, exit 3 in
  24 min 41 s; unit 11871 / 6 fail / 399 skip in both Machines, tcp 69/69 and
  553/553, embedded 43/43 and 349/349, tinyfs 9 / 0; interrupts during create,
  provisioning and steps all 130 with nothing left): cleanup runs `rsync` and `orb`
  in a session of their own and repeats `orb delete -f` until `orb list` no longer
  shows the name (a repeated Ctrl-C had lost the logs and cut the delete short while
  `run.env` claimed the logs were copied); 15-minute bounds on `orb create`, the
  package install, the Bun download and each copy; the Machine-side hash, the delete
  exit codes and the partial steps in the manifest; every step printed with its exit
  code; quiet dpkg. Reproduced first: without the detached session the burst test
  ends 4 instead of 130. The docs no longer claim that `--isolate-network` isolates
  the network.
- Trigger evals (the second session's work, now in this item):
  `scripts/agents/run-skill-evals.ts`, `docs/agents/skill-evals.md`, and
  `test/agent-skills-evals-runner.test.ts` (`--help`, `--dry-run` starts no agent,
  the runner type checks). Claude Code, six rewritten skills: should-trigger 40/54 ->
  51/54, false triggers 1/54 -> 0/54; Codex after only: 3/3 on its five listed
  skills, 2/3 false triggers on `bunqueue-working-sessions`; Gemini CLI: discovery
  7/7, triggers not measured.
- Evidence (host, diagnostic): `bun test test/agent-skills test/agent-harness`
  143 / 0 (10 files); `bun test test/docs-*.test.ts` 122 / 0; `bun run typecheck`
  and `bun run format:check` clean; `git diff --check` clean; `./init.sh` green in
  8 to 10 s; `generate-release-posts.ts --check` OK (259 posts); `check:docs-data` OK;
  every script passes `bash -n`, `--help` and `--dry-run` under bash 3.2.
  `ci-watch.sh` against real past runs, read-only: run 43336453775 exit 3, run
  43324514568 exit 1, `--sha 3e08f75b...` exit 0, an unknown commit exit 4.
- Gate: `bun run test:sandbox` green on the rebased tree `a0628e56` (unit 11787 /
  0 / 402, tcp 553 / 0, embedded 349 / 0, no anomalies;
  `artifacts/test-sandbox/2026-11-13T02-38-12.078Z/`). Skeptic: `PASS`, conditional
  on that run, with two minor notes, applied afterwards as two skill sentences
  (who can write a standing authorization; where the SDK jobs run). Those sentences
  and the state files are the only changes after the gate. `bun run test:model` and
  `bun run test:sandbox:sdk` are not triggered (no `src/` or `sdk/` change).
- Not run: the OrbStack Machine gate on the fixed scripts; that is the new item
  `machine-gate-real-rerun`.
- User requests so far: this work item. The commit was made by the coordinating
  session; no push, version bump or release was requested in this session.

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
