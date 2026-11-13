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

**Last Updated:** 2026-11-14
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

- Batch of 2026-11-13: `postgres-tests-never-run`, `sandboxed-worker-missing-cases`
  (+ `s3-restore-header-guard-test`, `mcp-unregister-worker-adapter-test`),
  `postgres-completion-prune-plan`, `worker-close-heartbeat-error`,
  `test-suite-speedups` and `machine-gate-real-rerun`; combined sandbox green on
  tree `b1a66b7a`. Evidence in `feature_list.json`.

### What's In Progress

- `harness-audit-hardening`: full harness audit repairs on its branch, including
  the PostgreSQL guard and Machine logging fixes. Product sandbox, fresh native
  Ubuntu and SDK sandbox passed on tree `22a1f496`; 404 state readers and final
  startup are green, whole-branch skeptic PASS on state tree `db30ef62`.
  Commit `9b69dcba` is pushed; PR #190 is in draft. The cancellation startup
  regression found by CI run `43519834491` is fixed and passed fresh sandbox
  and Ubuntu gates on tree `2ec6b76d`; final review, follow-up commit and CI
  remain. The user explicitly authorized fixes, commit, push and merge on main;
  no version bump or publication authorized.
- `machine-gate-interrupt-log-gaps` and `postgres-runner-guard-destructuring` are
  integrated into that candidate; their original staged worktrees are preserved.
  They remain owned while final commit, push and CI evidence are pending.

### What's Next

1. Finish `harness-audit-hardening`, including `postgres-runner-guard-destructuring`
   and `machine-gate-interrupt-log-gaps`. The CI watcher startup cancellation fix
   from run `43519834491` is gate-validated; finish state readers
   and skeptic review, commit/push the follow-up, watch PR CI to green and close
   its evidence, then merge and watch main CI. Align the original main checkout.
2. `postgres-completion-recheck-state-index`: the prune recheck's consumer-state
   probe on PostgreSQL 16 and 17 with stale statistics.
3. Owner decisions: `postgres-completion-read-model-plan` (trade-off measured,
   see its evidence), `worker-force-close-unreachable-broker`,
   `deprecated-public-apis-next-major`, `python-sdk-pypi-publication-gap`.

## Blockers / Risks

- `main` requires pull requests; only an account with bypass rights can push to it
  directly. The release push (CI's version gate tags, releases and publishes from
  `main`) therefore needs an account with write access to `main`, or a pull
  request merged by one.
- `harness-audit-hardening`: the initial push as `kernelvoid99` failed HTTP403.
  The user explicitly instructed using `egeominotti`; that existing account was
  activated, write access verified, and push succeeded. CI run `43519834491`
  failed only the new SIGTERM cancellation regression (heartbeat still changed
  after watcher exit). The startup race is now reproduced and fixed, with new
  sandbox/Ubuntu gates green; remote CI on the follow-up remains pending.
- The green product sandbox reports a TCP peak-memory anomaly: +78.9% against
  baseline, 209.5 MiB (5.1% of limit), falling to 67.8 MiB at the next two-second
  sample. No OOM, errors or end-growth signal; this is a transient observation,
  not evidence of a leak. See `artifacts/harness-hardening/final-sandbox-anomaly-review.json`.
- The release gates are long: `bun run test:sandbox` took 8.96 min of wall time on
  the last green run (2026-11-13, unit 6.85 min), and the SDK sandbox and both
  OrbStack Machines come on top.
- `harness-audit-hardening`: `CLAUDE.md` and `AGENTS.md` are 5 and 67 bytes under
  the 12,288-byte budget after instruction parity; the next rule needs more
  non-rule prose moved out first. `scripts/ci-watch.sh` has watched one live run
  (43355036181: FAILED, then FLAKY after a rerun), but not yet one waiting for the
  `npm` environment approval (that status is handled from GitHub's documentation,
  not from an observed run). The Machine gate fixes
  ran on real OrbStack on 2026-11-13 (`machine-gate-real-rerun`: exit 0, every
  interrupt cleaned up); the delete-retry path, a late create, a failing `orb list`
  and the 15-minute bounds are still proven with a fake OrbStack only.
- `worker-force-close-unreachable-broker` needs an owner decision: is a bounded
  forced close allowed to drop the final ACK flush to an unreachable broker? Ship
  only in a minor or major with an upgrade note. A 5 s grace while the pool has no
  connected client bounded `close(true)` (10.1 s to 5.1 s for a killed broker with a
  10 s `commandTimeout`), but a broker that restarts and stays down longer than 5 s
  then loses the queued ACK flush, so completed jobs may run again (skeptic round 2,
  CONDITIONAL). The code was removed from `worker-close-fixes`.
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

### 2026-11-14 — cancellation startup fix validated

- Frozen executable tree `2ec6b76dce8441415a0a6a0125a724c07d2b3d3e` fixes the
  launch-time cancellation race with signal/abort ownership before spawn and
  deferred owned-group cleanup. Red TERM/INT boundary tests0/2 on host/Linux;
  green host8/0, isolated Linux original case50/0 and neighbors91/0.
  `artifacts/harness-hardening/ci-cancel-startup-report.md`.
- `bun run test:sandbox` PASS: unit11916/0/403, TCP553/0 (69 suites),
  embedded349/0 (43), all error counters0,8.92min, no anomalies or OOM.
  Peak unit1.49GiB/PID184, TCP194.6MiB/PID65, embedded53.2MiB/PID40.
  Full logs/NDJSON and slow-test tables reviewed:
  `artifacts/test-sandbox/2026-11-13T22-49-51.544Z/summary.md`.
- Fresh `machine-gate.sh --distros ubuntu:24.04 --tree 2ec6b76dce8441415a0a6a0125a724c07d2b3d3e`
  PASS: Ubuntu24.04.5 arm64, Bun1.4.4+38afee6c8, effective4CPU/16GiB,
  unit12047/0/403, TCP553/0, embedded349/0, tinyfs9/0; typecheck890+2136
  and format2337 clean.21m24s; matching snapshot, logs copied, Machine deleted.
  `artifacts/machines/20261113T225904Z/manifest.md`.
- No SDK/runtime changes in this follow-up; separate SDK/model gates not
  triggered. Model suites ran in the full unit gates; the earlier six-SDK gate
  still covers unchanged SDK orchestration. Startup179/0/type/format green.
- Skeptic code preflight independently23/0 and sandbox evidence verified;
  final state readers and pre-commit PASS pending. Commit/push authorization
  persists, active account `egeominotti`. Merge main explicitly authorized after
  green CI; protection requires a normal squash/rebase, no bypass or force.

### 2026-11-13 — authenticated push and CI cancellation follow-up

- User explicitly instructed using `egeominotti`; switched to that existing
  authenticated account. Fresh skeptic pre-push PASS, commit `9b69dcba` pushed
  to `harness-audit-hardening`, tracking worktree clean. Draft PR #190:
  <https://github.com/egeominotti/bunqueue/pull/190>. The user subsequently
  authorized fixes, commit, push and merge on main. Merge follows green gates
  and CI through the normal protected branch path. No release authorized.
- CI run `43519834491`, attempt1: unit12046/1/399; all other jobs passed,
  including PostgreSQL16/17/18, TCP, embedded, SDKs, types, format and docs.
  The failure is `test/agent-skills-ci-cancellation.test.ts:72`, SIGTERM during
  a hung query: heartbeat expected `x`, received `xxxxx` after watcher exit.
  Full log: `artifacts/harness-hardening/ci-unit-failure.log`.
- The existing regression proves a failure on native Linux amd64. Root-cause
  investigation reproduced the original failure in isolated Linux, then forced
  the startup window deterministically: TERM/INT tests0/2 before the fix on host
  and Linux. A child can run before `spawn()` returns and before the supervisor
  registered cancellation, allowing default SIGTERM to leave its detached group.
- The shared supervisor now registers cancellation before launch and defers
  group cleanup until the PID is available; launch errors clear timers/listeners.
  Host focused8/0; isolated Linux original case50/0 repeated, neighboring
  CI/eval/Machine contracts91/0 across11files; typecheck890+2136 clean.
  Report: `artifacts/harness-hardening/ci-cancel-startup-report.md`. Existing
  heartbeat assertions remain intact and also verify the CLI is stopped when
  the watcher returns; a bystander process must survive.
- Full sandbox and fresh Ubuntu gate must cover the follow-up before the
  authorized commit/push. Separate model/SDK gates are not triggered by this
  CI/eval/Machine supervisor-only delta. The umbrella item remains active.

### 2026-11-13 — harness audit hardening

- Explicit user request: fix everything found in the harness audit, commit and
  push. No release or publication authorized. Branch `harness-audit-hardening`,
  base `edb86af4`, managed worktree `/Users/kernelvoid/.codex/worktrees/b7f5/bunqueue`.
- Plan: `docs/superpowers/plans/2026-11-13-harness-audit-hardening.md`.
- Audit: normal contracts 141/0, sandbox telemetry/lifecycle 27/0, startup green;
  adversarial fake-tool probes found gaps in Machine ownership/cleanup/evidence,
  sandbox verdict/cleanup/baselines, CI bounds/precedence, skill eval attribution,
  instruction parity and work-item ownership. Evidence under
  `artifacts/runner-guard-resume/harness-audit-probes/`.
- Regression-first repairs cover sandbox verdicts, complete summaries, cleanup
  and baselines; Machine ownership, late creates, bounded descendant cleanup and
  copied evidence; CI deadlines/cancellation and eval attribution/launch errors;
  instruction parity and startup inventory. Focused green: sandbox54/0,
  Machine62/0 plus7 audit probes, CI/eval50/0; startup179/0 in11s.
- Frozen executable tree `22a1f4960893ff27aa4b4922c2160d2078d3c458`:
  `bun run test:sandbox` PASS, unit11912/0/403, TCP553/0, embedded349/0,
  8.95min; `artifacts/test-sandbox/2026-11-13T21-44-23.117Z/summary.md`.
  TCP memory anomaly is recorded under Blockers / Risks; other anomalies none.
- `machine-gate.sh --distros ubuntu:24.04 --tree 22a1f4960893ff27aa4b4922c2160d2078d3c458`
  PASS, Ubuntu24.04.5 arm64, Bun1.4.4+38afee6c8, effective4CPU/16GiB;
  unit12043/0/403 (includes131 TypeScript SDK tests absent from sandbox),
  TCP553/0 (69 suites), embedded349/0 (43 suites), tinyfs9/0, typecheck890+2135
  and format2336 clean,21m19s. Snapshot hash matched; logs copied and Machine
  deleted. `artifacts/machines/20261113T215345Z/manifest.md`.
- `bun run test:sandbox:sdk` PASS, TypeScript882/0/0, Python219/0/0,
  PHP105/0/0, Go114/0/1, Rust92/0/1, Elixir145/0/1; each SQLite/PostgreSQL
  conformance18/18,6.26min, no anomalies or surviving processes.
  `artifacts/test-sandbox-sdk/2026-11-13T22-15-13.834Z/summary.md`.
- All full logs, totals, telemetry and slow tests reviewed. No engine lifecycle
  changes; separate `bun run test:model` not triggered, model suites ran in both
  full unit gates. SDK gate additionally validates shared runner changes.
- Whole-branch skeptic found two code blockers (exited launcher descendants and
  lost eval reports after launch rejection); both were reproduced and fixed.
  Independent follow-up found no remaining confirmed code defect and verified
  product/Ubuntu/SDK evidence. Whole-branch skeptic PASS on state tree
  `db30ef625ed8ff27516a2894b64ed042617b4c33`; final recorded-state re-review
  precedes commit. No remaining confirmed code blocker.
- Post-gate delta: docs/state only, `gate-delta.sh` exit3; reader tests404/0,
  30files39.19s, release-posts check259OK and docs data clean. Final `./init.sh`
  green10s,179/0, typecheck890+2135 and format2336 clean; both whitespace checks
  clean. Logs: `artifacts/harness-hardening/final-post-gate-tests.log`,
  `final-post-gate-delta.log`, `final-init.log`.
- Historical CONDITIONAL-only records remain historical evidence, not invented
  approvals. The newly integrated changes require a fresh final skeptic PASS.
- Original worktrees and unrelated work are preserved. No commit made yet;
  actual Git push follows the local commit, then CI if remote write succeeds.

### 2026-11-13 — resume PostgreSQL runner guard

- Explicit user request: inspect previous work and continue. This covers the fix,
  tests and review; it does not authorize commits, pushes or a release.
- Item: `postgres-runner-guard-destructuring`; branch
  `postgres-runner-guard-resume`, base `edb86af4`. Managed worktree:
  `/Users/kernelvoid/.codex/worktrees/b7f5/bunqueue`. The original worktree and
  the Machine-gate worktree remain unchanged.
- Baseline: `./init.sh` green, 124 contract tests pass, typecheck and format clean.
- Reproduction repeated: two temporary files outside the PostgreSQL runner's
  patterns read the URL using destructuring, one through a support helper. The old
  guard passes 4 / 0; the widened guard reports exactly both files, 4 pass / 1 fail.
  Fixtures removed. Logs: `artifacts/runner-guard-resume/{before,after}-mutants.log`.
- Verification on staged tree `8bf049756e2c03c43f996b8f76cedd7f1ea73a84`:
  - `bun test test/postgres-runner-coverage.test.ts`: 5 pass / 0 fail.
  - `./init.sh`: green, 124 contract tests pass; typecheck and format clean.
  - `bun run test:sandbox`: exit 0, unit 11777 / 0 / 403, TCP 553 / 0,
    embedded 349 / 0, 8.95 min, no resource anomalies. Unit peak RAM 1.57 GiB
    (39.3%), peak PIDs 403; slowest unit test is the workflow model (35.74 s),
    slowest integration file the TCP workflow engine (1.74 min).
    Report: `artifacts/test-sandbox/2026-11-13T20-13-47.754Z/summary.md`.
  - `machine-gate.sh --distros ubuntu:24.04 --tree 8bf04975`: exit 0,
    Ubuntu 24.04.5 arm64, Bun 1.4.4+38afee6c8, effective 4 CPUs / 16 GiB;
    unit 11908 / 0 / 403, TCP 553 / 0 (69 suites), embedded 349 / 0 (43 suites),
    tinyfs 9 / 0, typecheck 890 + 2120 files and format 2319 files clean.
    The 131 additional unit tests are from 16 TypeScript SDK files absent from
    the sandbox image. Report:
    `artifacts/machines/20261113T202258Z/manifest.md`; 21 min 12 s, Machine deleted,
    all logs copied. The snapshot content hash matched inside the Machine.
- Separate `test:model` and SDK sandbox not triggered (test guard/docs/state only);
  both full unit gates included the model suites. No Debian release gate needed.
- Independent investigation found no scoped defect. Initial skeptic CONDITIONAL
  only on the then-pending Machine result and final state; final skeptic PASS on
  state tree `12270964d9459641e19804c65de9d802a2c30057`. The reviewer independently
  verified snapshot identity, Machine cleanup and the 131 additional SDK passes,
  and ran documented-feature coverage (36 pass / 0 fail).
- Post-gate delta: state-only, `gate-delta.sh` exit 3. Fresh contracts and docs:
  `bun test --parallel=4 test/agent-harness test/agent-skills test/docs-*.test.ts`
  260 pass / 0 fail across 21 files; release posts check 259 OK; `check:docs-data`
  clean; final `./init.sh` green (124 pass / 0 fail, 8 s), typecheck, format and
  whitespace clean. Logs in `artifacts/runner-guard-resume/`.
- Integration/CI pending: no commit or push authorized. Item remains in-progress.
- Next: `machine-gate-interrupt-log-gaps` still needs its sandbox gate; this guard
  change is staged and validated, awaiting explicit integration authorization.

### 2026-11-13 — second batch

- On `main`: `worker-close-register-error`, `cpu-intensive-blocking-test-flake`,
  `split-oversized-test-files`, each with its own green sandbox and skeptic.
- Deferred: `postgres-completion-read-model-plan` (no shape found that fixes stale
  statistics without slowing the good-statistics case; numbers in its evidence).
- Not landed yet: `postgres-runner-guard-destructuring`,
  `machine-gate-interrupt-log-gaps` (sandbox gate still owed).
- Several background shells on the host exited 144 during the session; the
  machine-gate scripts were reviewed and do not signal outside their tree.

### 2026-11-13 — worker-close-register-error

- Item: `worker-close-register-error` (done), branch
  `worker-close-register-error`, base `154d6fc5`.
- Reproduction: `test/repro-worker-close-register-error.test.ts` (fake broker
  holding `RegisterWorker`). Unchanged code: 2 pass / 2 fail
  (`worker-register: ClientClosedError` emitted after `close()`, and the
  no-listener case). Fix: the `RegisterWorker` `.catch` in `registerWithServer()`
  drops `isOwnCloseRejection(error)`, the heartbeat rule. After: 4 / 0,
  `--rerun-each 10` 40 / 0; the running-Worker guard test fails against the mutant
  without `(_closing || closed)` (3 / 1).
- Docs: `docs/features/client-worker-sdk.md`, changelog `[Unreleased]` Bug fixes.
- Gates: `bun run test:sandbox` green on tree `c92b8cf5` (unit 11777 / 0 / 403,
  tcp 553 / 0, embedded 349 / 0); skeptic CONDITIONAL only on that gate.
### 2026-11-13 — cpu-intensive-blocking-test-flake

- Branch `cpu-intensive-blocking-test-flake`, base `154d6fc5`; done. Root cause in the test: its handler busy-looped 3 s in the process
  that hosted the broker, so no stall sweep ran during the block, and its wait
  accepted `waiting`, the state before the pull. Forcing the pull to win (wait
  for the handler to start before polling) made it fail 4 / 4 (embedded and
  TCP, job completed, never recovered); with stall detection disabled in `src/`
  the old test still passed 6 / 6.
- Fix (tests and docs only): `test/fixtures/stall-sweep-broker.ts` (broker in
  its own process, 100 ms sweep, dynamic port, exits when stdin closes) and
  `test/docs-worker-guide/broker-process.ts`; the handler asks the broker after
  the block and must see the job `waiting`/`delayed` with an attempt counted,
  then `completed`. Not a defect found on the way: the stale processor's late
  ACK completes the requeued job (Issue #33, `completeStallRetriedJob`).
- Proof: the new test fails on the stall-detection mutant (`Received: "active"`);
  passes 20 / 20, 20 / 20 under 18 CPU burners (load 41), whole file 27 / 27 under
  load. `bun run test:sandbox` green on tree `216e7069` (unit 11772 / 0 / 403, tcp
  553 / 0, embedded 349 / 0); skeptic CONDITIONAL only on that gate.
### 2026-11-13 — split-oversized-test-files

- Branch `split-oversized-test-files`, base `154d6fc5`. The five test files over
  300 lines are split by concern with no test changed:
  `workflow-new-features-{retry-parallel,signal-cleanup,observability,nested}`,
  `client-dlq-dedup-{config,inspect,retry,deduplication,worker}`,
  `long-running-timeout-{timeouts,liveness}`,
  `docs-queue-guide/advanced-{batching,forward}` and
  `lockExpiration{,-events}`; helpers in `test/support/workflow-wait-until.ts`,
  `client-dlq.ts` and `docs-counting-broker.ts`. The docs traceability table
  (`docs/features/documented-feature-verification.md`) names
  `advanced-forward.test.ts`.
- Proof (host, diagnostic): each original set and its split files give identical
  sorted test names and statuses (20, 51, 6, 8, 9 passing, 0 fail, 0 skip).
- Gates: `bun run test:sandbox` green on tree `df2e5338` (unit 11773 / 0 / 403,
  tcp 553 / 0, embedded 349 / 0); skeptic CONDITIONAL only on that gate.

### 2026-11-13 — integration of six items

- Integrated into `main` (branch `integration-batch`) from their own worktrees:
  `postgres-tests-never-run`,
  `sandboxed-worker-missing-cases` (+ `s3-restore-header-guard-test`,
  `mcp-unregister-worker-adapter-test`), `postgres-completion-prune-plan`,
  `worker-close-heartbeat-error`, `test-suite-speedups`; each had its own green
  sandbox and skeptic round. `machine-gate-real-rerun` is `done` from a real
  OrbStack run (evidence in `feature_list.json`).
- Not shipped: the bounded forced close (`worker-force-close-unreachable-broker`)
  needs an owner decision (Blockers / Risks).
- New items: `machine-gate-interrupt-log-gaps`, `split-oversized-test-files`,
  `postgres-runner-guard-destructuring`, `postgres-completion-read-model-plan`,
  `worker-close-register-error`, `cpu-intensive-blocking-test-flake`.
- Current State rewritten from `feature_list.json`; stale in-progress and blocker
  lines of already merged items removed.

### 2026-11-13 — postgres-tests-never-run

- Branch `postgres-tests-never-run`, base `2f1ad824`. Four files read
  `BUNQUEUE_TEST_POSTGRES_URL` but were not named `postgres-*`, so no runner set the
  URL for them and their 21 cases were skipped everywhere.
- First-ever run against local Docker PostgreSQL 16.16, 17.12 and 18.6 with the CI
  env vars: 36 pass / 0 fail on each. No test or product bug; `src/` unchanged.
- Changed: `scripts/test-postgres.ts` (`postgresTestPatterns`, adds
  `test/repro-postgres-*.test.ts`), the PostgreSQL case of the compat past-run-time
  file moved to `test/repro-postgres-compat-job-past-run-time.test.ts`, new guard
  `test/postgres-runner-coverage.test.ts`, `docs/testing.md`,
  `docs/features/postgres-multibroker.md`, changelog `[Unreleased]` Testing.
- `bun run test:postgres` on each local version: 547 pass / 1 skip (ten-broker
  soak) / 0 fail in 123 files. `bun run test:sandbox` green on tree `e8548701`
  (unit 11738 / 0 / 402, tcp 553 / 0, embedded 349 / 0); item `done`.
- New item `postgres-runner-guard-destructuring`: the guard does not see a
  destructured `BUNQUEUE_TEST_POSTGRES_URL` read.

### 2026-11-13 — sandboxed-worker-missing-cases (+ two test gaps)

- Branch `test-coverage-gaps`, base `2f1ad824`; working tree only, nothing
  committed, staged with `git add -A`. No `src/` change: no test exposed a bug.
- Added `test/sandboxed-graceful-stop.test.ts` (issue #39) and
  `test/sandboxed-wrapper-names-chaining.test.ts` (issue #24), with real Bun
  Workers: a gate file decides when a job may finish, and `Date.now` is frozen
  for the same-millisecond cases. They are stable on Bun 1.4.4 on the host (30 of
  30 sequential runs, 10 of 10 with `--parallel=4` and the sandboxed neighbours,
  10 of 10 under 8 busy CPU loops), so no test had to fall back to the pool seam.
- New items `s3-restore-header-guard-test` (`test/s3-restore-header-guard.test.ts`:
  the header check is the only refusal of an empty payload, which SQLite opens
  as a valid empty database) and `mcp-unregister-worker-adapter-test`
  (`test/mcp-tcp-unregister-worker.test.ts`, real broker, wire command recorded).
  Both ship in this change and are `done` with it.
- Mutation proofs (scratch worktree of `2f1ad824`, one mutant at a time) and the
  host checks are in the item's evidence. Docs: `docs/features/client-worker-sdk.md`,
  `backup-s3.md`, `workers-management.md`; changelog `[Unreleased]` Testing.
- Gates: `bun run test:sandbox` green on tree `4ab265ea` (unit 11750 / 0 / 402,
  tcp 553 / 0, embedded 349 / 0); all three items `done`.

### 2026-11-13 — postgres-completion-prune-plan

- Branch `postgres-completion-prune-plan`, base `2f1ad824`; done.
- Root cause: the plan, not an index. With statistics that do not cover the
  namespace, every scan is estimated at one row, so the candidate `SELECT` and the
  `DELETE` recheck of `prunePostgresCompletionTombstoneBatch` ran nested-loop anti
  joins that rescan the namespace's jobs per completion and per dependency, under
  the completion-retention advisory lock (10.2-11.0 s each on 619 completions on
  PostgreSQL 16.16, 17.12 and 18.6).
- Fix: the unchanged `SELECT` runs under `SET LOCAL enable_nestloop = off` (reset
  right after it); the `DELETE` recheck uses per-row `OFFSET 0` subplans. Same
  rows pruned (identical candidate lists and deleted sets on every dataset), same
  timings with good statistics. Numbers in the item's evidence.
- Test: `test/postgres-completion-prune-plan.test.ts` failed before the fix on all
  three versions (12.9-17.3 s against a 2 s bound) and passes after it (~15 ms).
- New item `postgres-completion-read-model-plan`: `loadPostgresCompletionResults`
  has the same stale-statistics problem (quadratic, 1.6 s on 4,834 completions).
- Gates: `bun run test:sandbox` green on tree `c2e0759a` (unit 11734 / 0 / 403,
  tcp 553 / 0, embedded 349 / 0); skeptic CONDITIONAL only on that gate. CI's
  PostgreSQL 16, 17 and 18.6 legs run the new test.

### 2026-11-13 — worker-close-fixes

- Item: `worker-close-heartbeat-error` (done), branch `worker-close-fixes`,
  base `2f1ad824`. `worker-force-close-unreachable-broker`
  was worked on in the same session and then removed from the change-set.
- Heartbeat: a `Heartbeat` or `JobHeartbeat` in flight when `close()` ends the
  Worker's own pool rejected with `ClientClosedError` and was emitted as `error`
  (unhandled without a listener). It is now dropped once `close()` has started;
  other heartbeat failures, and a `ClientClosedError` while the Worker runs, still
  surface. Before 1 / 3 fail, after 5 / 0, 50 / 0 over 10 reruns
  (`test/repro-worker-close-heartbeat-error.test.ts`). Skeptic round 1: PASS;
  round 3 CONDITIONAL, addressed (fake broker trimmed, running-Worker test proven
  against a mutant without the closing condition, docs wording).
- Forced close: `UnregisterWorker` (and any release or ACK flush) waits the
  `commandTimeout` after the broker was killed (10.1 s, 40.7 s for an ACK flush,
  with a 10 s timeout). Two bounded variants were tried; skeptic round 1 failed an
  unconditional 5 s grace (it cut a live slow broker), round 2 was CONDITIONAL on a
  grace armed only while disconnected (a broker restart longer than 5 s loses the
  queued ACK flush). Removed; the numbers and the open question are in the item's
  evidence and under Blockers / Risks.
- Gates: `bun run test:sandbox` green on tree `d1f6710f` (unit 11739 / 0 / 402,
  tcp 553 / 0, embedded 349 / 0); skeptic round 4 CONDITIONAL only on that gate.
  Next: `worker-close-register-error`.

### 2026-11-13 — test-suite-speedups

- Branch `test-suite-speedups`, base `2f1ad824`. The user asked for the unit job to
  be faster without losing coverage or weakening an assertion, with no default
  users see changed; no commit, push, stash or `bun run test:sandbox` in this
  session.
- Done: the fifteen slowest unit files poll the real condition with a deadline
  instead of sleeping. Stall and DLQ maintenance waits run on 100 ms (docs guide
  suites, `long-running-timeout`) or 50 ms (`lockExpiration`,
  `lock-race-conditions`, `bug-lock-token-race`) sweeps. The workflow and DLQ
  waits poll the state, and the unreachable-remote forward has a 3 s
  `commandTimeout`. The seam is `getSharedManager(dataPath, timers?)` in
  `src/client/manager.ts`: it is internal, applies only when it creates the
  manager, and throws if a manager exists. It is threaded through
  `CoreE2eHarness.start(mode, prefix, timers?)` and `startHarness(page, mode,
  timers?)`. Defaults stay asserted: 5000 ms in `test/shared-manager-timers.test.ts`
  and stall-detection, 60000 ms in the DLQ configuration suite.
- Measured on the host (3 runs per file, 4 at a time, baseline from an untouched
  `git archive 2f1ad824` copy): medians 676 s summed before, 117 s after, so about
  140 s of unit wall time saved on 4 workers. Per file in `feature_list.json`.
- Found: the cpu-intensive "non-yielding handler" test failed once in the
  unchanged baseline and is mostly vacuous. It is recorded as
  `cpu-intensive-blocking-test-flake`, not fixed here.
- Gates: `bun run test:sandbox` green on tree `293c1594`: unit 11748 / 0 / 402 in
  6.79 min (9.40 min on the same day's unchanged suite), tcp 553 / 0, embedded
  349 / 0. One host failure in the first of 4 runs stays unexplained (not
  captured, not reproduced in 3 loaded skeptic runs). Item `done`.

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

### 2026-11-13 — postgres-flakes

- Branch `postgres-flakes`, base `bfa290c7`, uncommitted, staged with `git add -A`.
  Two items in one worktree, as requested: `postgres-lifecycle-race-flake` and
  `postgres-sigkill-hook-timeout-flake`, both `in-progress` with `PARTIAL`
  evidence. Disposable `postgres:16-alpine` (16.16) and `postgres:17-alpine`
  (17.12) containers on 127.0.0.1, removed at the end.
- Lifecycle: no engine race. The assertion compared the rows of an unordered
  `getJobs(ids)` with the input order. It failed 3/50 with exactly the CI diff on
  a heap-order plan (index scans disabled, churned table) and 0/50 after the fix;
  20/20 on each version on default databases.
- SIGKILL: the `afterAll` stop of the brokers hit Bun's 5 s default deadline. The
  file ends at the brokers' first 60 s sweep, a sweep waits on the
  completion-retention advisory lock held by a 10 s prune query, and a graceful
  shutdown drains that wait. It failed 2/36 locally before the fix and 0/36 after;
  the deterministic probe failed 5/5 with the default deadline and passed 5/5 with
  the explicit one.
- New items: `postgres-completion-prune-plan`, `worker-close-heartbeat-error`,
  `worker-force-close-unreachable-broker`.
- Checks (host): `bun run typecheck`, `bun run format:check`, `git diff --check`,
  `./init.sh` green. Not run: `bun run test:sandbox` (excluded by the request), the
  skeptic, CI. Nothing committed or pushed.

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
