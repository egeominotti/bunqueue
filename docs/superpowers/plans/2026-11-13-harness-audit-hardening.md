# Harness Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Fix every reproduced harness audit defect, integrate the pending PostgreSQL guard and Machine logging repairs, commit and push the validated candidate, then merge into main as explicitly requested in the follow-up.

**Architecture:** Preserve the current Bun/TypeScript and Bash 3.2 harness. Enforce honest verdicts, bounded owned-process cleanup and accurate skill source attribution at existing boundaries. Keep product scheduling and public APIs unchanged.

**Tech Stack:** Bun 1.4.4, TypeScript ESM, Bash 3.2, disposable OrbStack Machines and Docker containers.

**Spec:** The user's request to fix everything, commit and push; audit reproductions in `artifacts/runner-guard-resume/harness-audit-probes/`; mandatory rules in `AGENTS.md`.

## Global Constraints

- Preserve all original worktrees and unrelated changes. No release or version bump.
- One active work item on this branch; all repository content in English.
- Add regression tests and observe the expected failure before implementation.
- No source file over 300 lines; use only `bun check` and `bun fmt`.
- Never signal or remove resources not owned by the current operation.
- Commit and push require a fresh skeptic PASS each. Sandbox and Ubuntu gates must cover the final executable tree.
- Live skill evaluations are unnecessary: deterministic fake CLIs reproduce these defects without subscription calls.

## Review Focus

- A daemon may accept creation before its CLI fails: keep uncertain ownership until settlement proves cleanup.
- A killed shell may leave children holding pipes: terminate the owned process tree and bound stream draining.
- Failed counters, missing logs or failed cleanup must never produce a successful gate.
- A known CI failure outranks unavailable history; deadlines apply to every external query and retry.
- Skill discovery and loading must identify this checkout and successful commands, not stale user copies or failed reads.

### Task 1: Machine gate lifecycle and evidence

**Files:** `.agents/skills/bunqueue-running-machine-gates/scripts/*.sh`, its `SKILL.md`, `test/agent-skills-machine-*.test.ts`, relevant test helpers.

**Interfaces:** Keep CLI flags and documented verdict codes; exit 130 requires all owned Machines deleted. Partial log collection is infrastructure failure. Keep cleanup bounded with owned-process termination.

- [x] Add deterministic regressions for failed-but-accepted create, concurrent run-name collisions, `--keep` plus interrupt, hung cleanup listing, orphan descendants after timeout, and partial/missing log copy-back; run them red.
- [x] Integrate the existing staged interruption/logging fix from its original worktree without overwriting other work.
- [x] Fix only the proven lifecycle/evidence gaps; split helpers if necessary.
- [x] Run Machine harness contracts and original audit probes green; review scope independently.

### Task 2: Sandbox verdicts, reporting and cleanup

**Files:** `scripts/test-sandbox*.ts`, a small cleanup helper if needed, `test/repro-harness-sandbox-*.test.ts` and telemetry tests.

**Interfaces:** `suitePassed` remains the shared predicate for product/SDK/report/baseline success. Reject reported failed tests regardless of exit code. Incomplete baseline data cannot prevent the current report. Failed container removal remains owned and reports failure.

- [x] Add real reporting and fake-Docker runner regressions for failure counters, malformed baseline and failed cleanup; run red.
- [x] Implement the narrow predicate, baseline validation and retryable cleanup fixes without changing the SDK protocol or runtime.
- [x] Run focused regressions and all sandbox telemetry/lifecycle tests green; review independently.

### Task 3: CI watcher and evaluation runner

**Files:** `.agents/skills/bunqueue-running-gates/scripts/ci-watch.sh`, `scripts/agents/run-skill-evals.ts`, small focused helpers, matching tests, `docs/agents/skill-evals.md`.

**Interfaces:** Preserve `FAILED > NO VERDICT > FLAKY > GREEN`; enforce wall-clock timeout across queries/history/retries. Discovery failure starts zero evaluation sessions. Codex loading requires successful completion against this checkout's skill path.

- [x] Convert all six tools audit reproductions into deterministic regressions and observe red.
- [x] Bound and clean owned CLI trees even if SIGTERM is ignored; preserve conclusive failure verdicts.
- [x] Stop immediately after invalid discovery; verify exact skill path and successful read events.
- [x] Run focused CI/evaluation contracts and audit probes green; review independently.

### Task 4: Instructions, state and integration

**Files:** `AGENTS.md`, `CLAUDE.md`, instruction contracts, `feature_list.json`, `progress.md`, `docs/agents/README.md`, `docs/testing.md`, changelog.

- [x] Add a failing parity contract for user-change preservation, deterministic pagination/migrations, scheduling regressions and test-typecheck protections.
- [x] Align mandatory instructions without exceeding the instruction budget; update state so an owned staged item is not advertised ready.
- [x] Record historical CONDITIONAL-only evidence honestly without inventing approval; new integrated changes receive a fresh PASS.
- [x] Include technical documentation and an Unreleased changelog entry for all changes.

### Task 5: Gates, commit, push and CI

- [x] Run `./init.sh`, all focused regressions/contracts, `bun run typecheck`, `bun run format:check`, both diff whitespace checks.
- [x] Stage and freeze the candidate; run `bun run test:sandbox` and a fresh native Ubuntu 24.04 Machine gate, serially; review full logs, totals and anomalies.
- [x] Record evidence; prove any state-only delta and rerun its readers. Get whole-branch skeptic PASS.
- [ ] Commit with the changelog, specific message and recorded evidence; inspect outgoing commit(s), get pre-push skeptic PASS, then push without force.
- [ ] Watch CI to green; if branch protection rejects a direct main push, preserve the commit on a feature branch and use the normal PR path. Never change protection rules.
- [ ] After the CI cancellation follow-up passes its gates and PR CI, review and merge PR #190 through the normal protected-main path; watch the main CI run and align the original clean main checkout without discarding changes.

## Execution ledger

- Base: `edb86af4`; candidate worktree `/Users/kernelvoid/.codex/worktrees/b7f5/bunqueue`.
- User explicitly authorized fixes, commit and push. No publication authorized.
- PostgreSQL guard's executable change already passed sandbox and Ubuntu; broader harness edits require new gates.
- Ruling: one integration item owns this audit batch; existing completed work and original staged worktrees remain preserved.
- Product sandbox, fresh Ubuntu and SDK sandbox passed on frozen tree `22a1f4960893ff27aa4b4922c2160d2078d3c458`; complete counts, artifacts and the transient TCP memory observation are recorded in `feature_list.json` and `progress.md`.
- State-only delta proved (exit3), readers404/0, final startup179/0/type/format green; whole-branch skeptic PASS on state tree `db30ef625ed8ff27516a2894b64ed042617b4c33`. Review this final recorded-state delta before committing.
- Local commit and actual push remain; the connected GitHub account reports no repository write permission. Never claim push or CI success without evidence.
- Follow-up: user explicitly requested account `egeominotti`, then fixes, commit, push and merge on main. Account switched, commit `9b69dcba` pushed, draft PR #190 opened. CI run `43519834491` found a reproduced cancellation startup race; fix, new gates and integration remain pending. No version bump or publication authorized.
- 2026-11-14: startup fix passed sandbox (11916unit/553TCP/349embedded) and fresh Ubuntu (12047unit/553TCP/349embedded/9tinyfs), no failures, on frozen tree `2ec6b76dce8441415a0a6a0125a724c07d2b3d3e`. Full evidence in the state files. Final state-only readers/review, follow-up commit/push, PR CI and authorized squash merge/main CI remain.
