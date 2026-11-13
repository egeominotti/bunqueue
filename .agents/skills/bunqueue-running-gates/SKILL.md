---
name: bunqueue-running-gates
description: "Selects, runs and reads the bunqueue validation gates: bun run test:sandbox (unit, TCP and embedded suites in disposable containers), bun run test:model for queue semantics, bun run test:sandbox:sdk for sdk/ changes, plus typecheck, format and whitespace checks. Covers the artifacts and KPIs under artifacts/test-sandbox, how to classify a failure (parallel-only, environment, real), how a new file reaches the test image, and how to prove that a change made after a green gate is docs-only. Use when about to commit any bunqueue change, when a sandbox, model or SDK gate fails or shows anomalies, when a test passes on the host but fails in the container, or when asked whether a change still needs a gate. Not for OrbStack Machine runs (bunqueue-running-machine-gates) or benchmarks, which run natively on macOS only."
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

Repository tests run in isolated OrbStack Machines by default, iteration included: a
run on the macOS host is diagnostic only ([CLAUDE.md](../../../CLAUDE.md#mandatory-gates)).
The Machines supplement the sandboxes and never replace them.

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

## Gotchas

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
