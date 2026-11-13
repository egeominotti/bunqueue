---
name: bunqueue-fixing-bugs
description: "Runs the bunqueue reproduce-first bug workflow. Use when a bug, regression, crash, wrong result, data loss, hang or flaky behavior is reported in bunqueue (server, client, workflow engine, CLI, MCP, SDKs), when a GitHub issue describes a defect, or when a skeptic, model-campaign or CI finding needs a fix. Covers the regression test that fails first, subagents that prove the fix, docs and changelog in the same change, the gates, and skeptic rounds until PASS. Not for features without a defect, or for only running the gates (bunqueue-running-gates)."
license: MIT
metadata:
  short-description: Reproduce, fix and prove a bunqueue bug
---

# Fixing a bunqueue bug

The rules this procedure serves live in [CLAUDE.md](../../../CLAUDE.md) and
[AGENTS.md](../../../AGENTS.md): reproduce before fixing, gates before a commit, the
skeptic before every commit and push, docs and changelog in the same change, and
nothing is committed or pushed without the user's explicit request. This skill is the
order of work and the traps found in real sessions.

Start the session first (bunqueue-working-sessions): one work item, `in-progress`,
with its branch.

## 1. Reproduce: the test comes first

1. Write the regression test before touching runtime code. Name it after the issue or
   symptom: `test/repro-issue-<n>-<topic>.test.ts`; a model-campaign finding becomes
   `test/repro-model-<topic>.test.ts`.
2. Drive the public or real persistence path (Queue/Worker over TCP or embedded, a real
   SQLite file) and assert both the returned result and every counter or state the bug
   corrupts. A unit test of a private helper passes even when the wiring is broken.
3. Run it on the unfixed code and read the failure:

   ```bash
   BUNQUEUE_EMBEDDED=1 bun test test/repro-issue-<n>-<topic>.test.ts
   ```

   It must fail on the assertion that describes the bug. A typo, a missing import, a
   timeout, a port clash or a setup error is a failure for the wrong reason and proves
   nothing; fix the test until the failure message names the bug. Keep that output: the
   Definition of Done asks for a test that failed before the fix.
4. Follow the test hygiene of [docs/testing.md](../../../docs/testing.md#test-hygiene):
   fresh server, `port: 0`, unique queue names and temporary SQLite paths, closed
   clients, polling with a deadline instead of fixed sleeps.

## 2. Fix with subagents, judged by the test

- Brief each subagent like a peer: the failing test path and its output, the files that
  are likely involved, what is ruled out, and the constraints (scope, 300 lines per
  file, the lock hierarchy, no `await` inside a shard critical section). Ask for the
  smallest change that makes the test pass without editing the test. Templates for
  this brief and the skeptic's: [references/briefs.md](references/briefs.md).
- When the cause is unclear, let two or three subagents try different hypotheses in
  parallel and choose by evidence: the regression test, the neighbouring test files,
  and the model campaign when it applies.
- Never weaken or rewrite the reproducing test to make it pass. If the test itself was
  wrong, fix it and show again that it fails on the unfixed code.
- Keep the fix compatible: change the broken behavior only. Anything else a user could
  observe (a default, a signal, a log line, an error message) is a behavior change that
  needs its own decision and, at release time, an Upgrade notes entry.

## 3. Prove it

```bash
BUNQUEUE_EMBEDDED=1 bun test test/repro-issue-<n>-<topic>.test.ts   # now passes
BUNQUEUE_EMBEDDED=1 bun test test/<neighbouring files>.test.ts       # still pass
bun run typecheck
bun fmt --check --no-script src test
git diff --check
```

Run `bun run test:model` first when the change touches anything on its trigger list
in [CLAUDE.md](../../../CLAUDE.md#mandatory-gates). Iterate in an isolated OrbStack
development Machine where you can; a macOS-host run is diagnostic only, and the gates
are the sandbox and the Machine gate (step 5).

## 4. Docs and changelog in the same change

- The module's `docs/features/<slug>.md`, plus [docs/data-model.md](../../../docs/data-model.md)
  for a type, table, TCP command, endpoint, env var or default, and
  [docs/architecture.md](../../../docs/architecture.md) for a data-flow change.
- An entry under the `## [Unreleased]` heading of
  [the changelog](../../../docs/src/content/docs/changelog.md), in its `### Bug fixes`
  subsection (add the subsection if the section has none yet): the user-visible
  symptom, the cause, the fix, and any behavior change. Numbers only from real
  measurements.

## 5. Gates

Follow bunqueue-running-gates: `bun run test:sandbox` after any code change (about
9 minutes; run it in the background), `bun run test:sandbox:sdk` when `sdk/` changed,
and the final Linux validation in a fresh Ubuntu 24.04 Machine
(bunqueue-running-machine-gates).
Record the gated tree with `git write-tree` and review `summary.md`, not just the exit
code.

## 6. Skeptic rounds until PASS

1. Stage the complete change first: the skeptic reads `git diff --staged`, so an
   unstaged hunk is invisible to it.
2. Invoke the `skeptic` subagent (profiles `.claude/agents/skeptic.md` and
   `.codex/agents/skeptic.toml`) with the bug, the reproducing test and its
   before/after output, the gate results and their artifact paths.
3. `FAIL`: fix every concern, rerun what it touches (the gate too, if code changed),
   and invoke it again. `CONDITIONAL`: fix what you can; the rest needs the user's
   explicit confirmation. `PASS`: commit only if the user asked for a commit.
4. Expect more than one round. Past rounds found real defects every time: a server
   started under `nohup` that a new `SIGHUP` handler changed from "ignored" to
   "reloads", a Docker restart policy that treats `docker kill -s HUP` as a manual stop,
   a rebound unix socket that lost its mode and owner, and log lines that claimed more
   than had happened. Answer a concern with a test or a fix, not an argument.
5. After the last fix, the gate evidence must describe the final staged tree; prove any
   later delta (bunqueue-running-gates).

## Gotchas

- `git stash` is shared by every worktree of the repository; another session can pop
  your entry. Set work aside with a temporary commit instead.
- A test that reads a new root-level file (a fixture, a config) passes on the host and
  fails in the sandbox with `ENOENT` unless [Dockerfile.test](../../../Dockerfile.test)
  copies it and `Dockerfile.test.dockerignore` allow-lists it. `test/` itself is copied.
- To show that an edited reproducing test still fails on the old code, run it in a
  temporary `git worktree add --detach <dir> HEAD` with the test copied in and
  `node_modules` symlinked, then `git worktree remove <dir>`; never revert files in
  the shared worktree.
- Bun discovers test files in readdir order, which differs between macOS and Linux; a
  leaked embedded manager or timer shows up as a failure in a different file. Close
  every Queue, Worker and manager, and claim the singleton with
  `beforeAll(shutdownManager)` in suites with a persistent `dataPath`.
- A fix found while fixing something else is a new `not-started` item in
  `feature_list.json`, not part of this change.
- A host-only green run is diagnostic. The Linux sandbox has caught failures the macOS
  host passed (package layout, readdir order, missing files in the image).
