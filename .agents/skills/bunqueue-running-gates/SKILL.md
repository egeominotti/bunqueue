---
name: bunqueue-running-gates
description: "Selects, runs and reads the bunqueue validation gates. Use when about to commit a bunqueue change or asked which gate it needs, when bun run test:sandbox, test:model or test:sandbox:sdk fails or shows anomalies, when a test passes on the host but fails in the container, when reading a report, totals or KPIs under artifacts/test-sandbox, when a change lands after a green gate, or when watching CI after a push. Covers failure classification and model replay by seed. Not for OrbStack Machine runs (bunqueue-running-machine-gates) or benchmarks."
license: MIT
metadata:
  short-description: Choose, run and read the bunqueue test gates
---

# Running the bunqueue gates

Which gate is mandatory, and when, is stated in [CLAUDE.md](../../../CLAUDE.md#mandatory-gates)
and [AGENTS.md](../../../AGENTS.md#validation); the rationale and every command are in
[docs/testing.md](../../../docs/testing.md#agent-test-rules). This skill is how to run
them so the result is evidence for the tree you commit.

## Choose the gates

| The change touches | Run |
| --- | --- |
| Any code: `src/`, `test/`, `scripts/`, `bench/`, `examples/`, config, Dockerfiles, workflows | `bun run test:sandbox` |
| Lifecycle, persistence/recovery, scheduling, dependencies, dedup, leases, limits, counters, temporal indexes, `jobIndex` | `bun run test:model` first, then the sandbox |
| Anything under `sdk/` | `bun run test:sandbox:sdk` as well as the sandbox |
| Always | `bun run typecheck`, `bun run format:check`, `git diff --check` and `git diff --cached --check` |
| Final Linux validation of a candidate | a fresh Ubuntu 24.04 OrbStack Machine on the native architecture, plus Debian 13 for every release (bunqueue-running-machine-gates) |
| Only docs or state files, after a green gate | prove the delta and rerun the tests that read them ([below](#prove-a-post-gate-delta)) |
| Anything, once it is pushed | watch the CI run of the pushed commit until it is green ([below](#after-the-push-watch-ci)) |

Repository tests run in isolated OrbStack Machines by default, iteration included: a
run on the macOS host is diagnostic only ([CLAUDE.md](../../../CLAUDE.md#mandatory-gates)).
The Machines supplement the sandboxes and never replace them.

Sandbox success requires a zero exit code, no reported failures or test errors,
and complete valid nonempty results. Failed Docker cleanup fails the suite and retains ownership for
retry; invalid baseline reports are ignored. See
[harness reliability](../../../docs/features/agent-harness.md).

## Freeze the tree, then run

The sandbox builds the working tree as it is when `docker build` reads the context,
uncommitted and untracked allow-listed files included. Evidence names one tree, so:

1. Stage everything the change contains, then check that nothing is left outside the
   index: `git status --porcelain` shows only staged entries (first column), and
   `git diff --quiet` succeeds.
2. Record the tree: `git write-tree` (it writes a tree object, never the index).
3. Start the gate in the background and do not edit the worktree until it finishes.
   `bun run test:sandbox` takes about 9 minutes; the SDK sandbox takes longer and
   snapshots the worktree when it starts, not when the first sandbox started.
4. When it ends, `git write-tree` again. The same hash means the result covers the
   tree; a different hash means a delta to prove or a gate to rerun.

## Read the result

Open `artifacts/test-sandbox/<timestamp>/summary.md` (SDK:
`artifacts/test-sandbox-sdk/<timestamp>/summary.md`) and report more than the exit
code: per-suite pass / fail / skip totals, the Anomalies column, duration against the
baseline, peak memory and PIDs, and the slowest tests. Field meanings, the JSON files
and retained containers: [references/artifacts.md](references/artifacts.md).

Evidence line for `feature_list.json` and the skeptic:

```text
bun run test:sandbox on staged tree <hash>: unit <n> pass / 0 fail / <n> skip,
tcp <n> / 0, embedded <n> / 0, anomalies none, artifacts/test-sandbox/<timestamp>/
```

## Classify a failure

1. **Image build failed**, or a test fails with `ENOENT` under `/workspace` while the
   host passes: a file the test reads is not in the image. Add it to both
   [Dockerfile.test](../../../Dockerfile.test) (a `COPY`) and
   `Dockerfile.test.dockerignore` (an allow-list entry); either one alone is not enough.
2. **Fails only in the parallel run**: rerun with `BUNQUEUE_TEST_SEQUENTIAL=1 bun run
   test:sandbox`. Passing sequentially means contention: still a test to harden
   (timing assumptions, fixed sleeps), not proof of a product bug.
3. **Environment, not product**: a binary that is missing in one environment (the
   OrbStack Machines have no `node`), host-only state, a translated architecture.
   Name the environment difference and prove the test passes where it exists.
4. **Real**: reproduce it with a focused test and switch to bunqueue-fixing-bugs.

Memory growth in the KPIs is a signal to investigate, not proof of a leak: unit tests
share one process. Confirm with a focused repeated-process, post-GC reproduction.

## The model campaign

`bun run test:model` runs the fast-check model against a real TCP broker and SQLite.
On failure keep the printed seed, path and size, and replay exactly:

```bash
BUNQUEUE_MODEL_SEED=<seed> BUNQUEUE_MODEL_PATH=<path> BUNQUEUE_MODEL_SIZE=<size> bun run test:model
```

Decide whether the model or the engine is wrong ([docs/testing.md](../../../docs/testing.md#model-campaign-rules));
an engine bug gets a deterministic `test/repro-model-*.test.ts` before any fix. Never
weaken an invariant to get a green run.

## Prove a post-gate delta

A late changelog line or progress note after a green gate does not always need another
9-minute run, but it needs proof that nothing executable changed. Run it, do not read
it:

```bash
bash .agents/skills/bunqueue-running-gates/scripts/gate-delta.sh --gated <hash from git write-tree>
```

[scripts/gate-delta.sh](scripts/gate-delta.sh) exits 0 (no delta), 3 (docs-only: it
lists the focused tests to rerun), 1 (code changed: rerun the gate) or 4 (Git error).
The image comparison and what counts as docs-only:
[references/post-gate-deltas.md](references/post-gate-deltas.md).

## After the push: watch CI

A push is not finished when `git push` returns. The work item is done when the CI run
of the pushed commit is green ([CLAUDE.md](../../../CLAUDE.md#definition-of-done),
[AGENTS.md](../../../AGENTS.md#definition-of-done)): two pushes once went out with a red
run that nobody opened, and a later one needed a rerun for a flaky job. The push itself
still needs the user's authorization; watching only reads.

1. Find the run of the commit you pushed, by its full SHA:

   ```bash
   gh run list --commit "$(git rev-parse HEAD)" --json databaseId,workflowName,status,conclusion
   gh run list --branch main --limit 1 --workflow CI --json databaseId,headSha,status,conclusion
   ```

   The second command is the newest `CI` run on `main`: check that its `headSha` is your
   commit before trusting it.

2. Wait for it with a bound (a push run takes roughly 10 to 20 minutes; a publication
   run waits for an approval and takes longer). Run the script rather than typing the
   loop:

   ```bash
   bash .agents/skills/bunqueue-running-gates/scripts/ci-watch.sh --sha "$(git rev-parse HEAD)"
   ```

   [scripts/ci-watch.sh](scripts/ci-watch.sh) takes `--sha <full sha>` or `--run <id>`,
   gives up after `--timeout` seconds (default 2700) and exits 0 (GREEN), 1 (FAILED),
   3 (FLAKY: green only after a rerun) or 4 (NO VERDICT: `gh` missing or failing, no
   run, a cancelled run, a run waiting for an approval, or still running at the
   timeout). It never reruns, cancels or approves anything. The same by hand:

   ```bash
   id=<run id>
   for poll in $(seq 1 90); do # 90 x 30 s = 45 minutes, then stop waiting
     [ "$(gh run view "$id" --json status --jq .status)" = completed ] && break
     sleep 30
   done
   gh run view "$id" --json status,conclusion,jobs \
     --jq '{status, conclusion, failed: [.jobs[] | select(.conclusion == "failure") | .name]}'
   ```

3. Red (exit 1): read the failed steps before deciding anything:

   ```bash
   gh run view <id> --log-failed | tail -n 120
   ```

4. Flake or regression? One attempt cannot tell, and neither can a single red matrix
   leg: the Python 3.9 SDK job failed on three pushes in a row while every other leg
   was green, because the runner image had lost Python 3.9. Signs of a regression or a
   broken runner: the log names something the commit changed, the same job is red on
   earlier commits (`gh run list --branch main --workflow CI --limit 5`), or it fails
   locally. Signs of a flake: a timing or race assertion in a test the commit does not
   touch (a docs-only commit, for example). Then rerun the failed jobs once:

   ```bash
   gh run rerun <id> --failed
   bash .agents/skills/bunqueue-running-gates/scripts/ci-watch.sh --run <id>
   ```

   - Exit 3, green on the rerun: CI is green and the flake is real. Add a
     `not-started` work item naming the test, the job, the run id and the attempt,
     with "reproduce first" in its description (a stress loop in the environment that
     failed); `postgres-lifecycle-race-flake` is the model. A flake is never silently
     ignored and never rerun a second time.
   - Exit 1 again: a job that fails in every attempt is a regression or a broken
     runner. `main` is red: say so, then fix it with a reproducing test first
     (bunqueue-fixing-bugs).

   Do not rerun a run that reached the release jobs (tag, GitHub release, Docker, npm):
   a rerun repeats them, and those are the user's to request (bunqueue-releasing).

5. Record it in the evidence: `CI run <id> (attempt <n>) on <sha>: GREEN (ci-watch.sh
   exit 0), <url>`, or the flake's work item id next to an exit 3.

After an `sdk/` change, check the SDK jobs too. On a push they are not a run of their
own: `CI` calls the `SDK` workflow, so they are the `Official SDKs / ...` jobs of the
`CI` run that `ci-watch.sh` already judges, and a red one makes that run FAILED. The
`SDK` workflow runs by itself only on its weekly schedule and on a manual dispatch;
watch such a run with `--workflow SDK` (`ci-watch.sh --sha <full sha> --workflow SDK`,
or `gh run list --workflow SDK --limit 3` to find it). Without such a run for the
commit, `--workflow SDK` waits until the timeout and exits 4.

## Gotchas

- Live CI watching requires the repository's pinned Bun as well as `gh`; help and
  dry-run remain read-only previews. The timeout covers queries, retry waits and
  attempt history; unavailable history cannot downgrade a known FAILED verdict.
  [bounded-command.ts](../../../scripts/agents/bounded-command.ts) uses
  [skill-eval-process.ts](../../../scripts/agents/skill-eval-process.ts) to terminate
  the owned CLI group, escalating from TERM to KILL after 100 ms.
- `gh run list --branch main --limit 1` alone returns the newest run of any workflow:
  an `issue_comment` run of the Claude Code workflow, concluded `skipped`, is often
  newer than CI. Filter with `--workflow CI`, or list by `--commit`.
- `gh run list --commit` wants the full 40-character SHA; for an abbreviated one it
  returns an empty list, which reads as "no run yet".
- `gh run watch <id>` has no time bound and a green rerun looks like any green run:
  `ci-watch.sh` is bounded and reports the rerun as exit 3.

- `bun run test:sandbox` is matched by nothing else: `test:sandbox:sdk`, a host
  `bun test` or `./init.sh --full` on a different tree do not replace it.
- Without Docker the native commands are diagnostic only; report the missing sandbox as
  a blocker instead of committing.
- The unit container is not the host: Bun's `node` there is a fallback shim, the user is
  `bun`, `TZ=UTC`, there is no network and no `.git`. A test that shells out to `git`,
  `node` or the network must handle that.
- `bunfig.toml` ignores `artifacts/**` at the repository root: a test file placed there
  is never discovered, and stale copies kept there never run.
- The image tag `bunqueue-test:local` is shared: the next sandbox run anywhere on the
  machine overwrites it, so extract `/workspace` for a comparison before starting
  another run.
- Benchmarks never run in the sandbox or a Machine; they are native macOS only.
