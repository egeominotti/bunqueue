# Test Quality and Duration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Implement the approved test audit without changing production behavior.

**Architecture:** Real behavioral assertions and test-owned synchronization replace vacuous checks and fixed observation waits. Shared contracts preserve embedded/TCP coverage; concern-sized test modules preserve every nonredundant scenario.

**Tech Stack:** Bun1.4.4, TypeScript ESM, real SQLite/TCP, isolated native Ubuntu development environments and final sandbox/Machine gates.

**Spec:** `docs/superpowers/specs/2026-11-14-test-quality-design.md`.

## Global Constraints

- No src/, sdk/, dependency, CI or gate-runner changes; no skip weakening.
- All content English; manual edits with apply_patch; bun check/bun fmt only.
- Preserve all user changes/worktrees and the model/crash/long-poll regressions.
- Changed/new test modules at most300lines; split only the touched test families.
- Root owns docs/changelog/state and integration; workers never commit or spawn agents.
- Use isolated development environments for iteration; final full sandbox and fresh native Ubuntu are mandatory. No per-task commits before those repository gates.
- Temporary mutants live only in disposable environments/copies; restore and verify real source after proofs.

## Review Focus

- Empty fixtures and unmet polling deadlines must fail, with useful diagnostics.
- Ownership token, exact admitted count, simultaneous starts and retained IDs are observable behavior.
- Moving a test preserves setup, persistence mode, error branch and assertions.
- Faster maintenance cannot consume entries before manual-expiry assertions.
- Completion can precede event delivery; wait for each actual observation and always clean resources.

### Task 1: Strengthen weak behavioral cases

**Files:** `test/workerManualMethods.test.ts`, `test/backpressure.test.ts`, `test/client-dlq-dedup-inspect.test.ts`, `test/support/client-dlq.ts`; create `test/backpressure-rate-limits.test.ts` and narrowly needed test support files.

**Interfaces:** Real Queue/Worker operations; helpers fail when fixtures cannot reach their expected state. No shared interfaces with other tasks.

- [x] Characterize weak tests on disposable mutants: no-op lock extension, ignored rate limit, no-op concurrency/rate removal and empty DLQ/ignored offset. Preserve before-output.
- [x] Require a fetched job and its real token; assert exact lock extension success/rejection and real lease/state behavior.
- [x] Remove only the three method-existence tests and listenerCount-only stalled test; preserve real manual-job and emitted-stall coverage.
- [x] Use barriers/counters and exact queue state to prove rate/concurrency limits and removal. Refill observation retains the real window.
- [x] Make DLQ helper deadline failure explicit; require known IDs/counts and exact ordered limit/offset slices, with no conditional assertions.
- [x] Keep changed files at most300lines; prove mutants fail improved cases and real implementation passes focused Linux cases. Report any actual product defect rather than changing src/.

### Task 2: Remove equivalent cases and split legacy files

**Files:** `test/ack-operations.test.ts`, `test/job-management-operations.test.ts`, `test/cli.test.ts`, `test/client.test.ts`.

**Create:** `test/ack-operations-failures.test.ts`, `test/ack-operations-batch.test.ts`, `test/ack-operations-edge.test.ts`; `test/job-management-mutations.test.ts`, `test/job-management-query.test.ts`, `test/job-management-queue-control.test.ts`, `test/job-management-integration.test.ts`; `test/cli-queue-commands.test.ts`, `test/cli-formatting-and-observers.test.ts`; `test/client-worker-basic.test.ts`, `test/client-job-and-events.test.ts`. Test-only fixture helpers may be extracted if needed, each at most300lines.

**Interfaces:** Retained test names, bodies and fixture semantics except the three explicitly identified vacuous client assertions below; default Bun discovery includes the new files. No changes to surviving counterpart files are required.

- [x] Capture a case/fixture inventory and narrow Linux baseline before changes.
- [x] Remove ack “update jobIndex to completed location” duplicated by the preceding completed-state case; keep counter/result/error coverage.
- [x] Remove management count-after-pull and empty-queue resume cases covered by queueControl.test.ts; retain delayed counts and resume with jobs.
- [x] Remove CLI ListWebhooks and invalid-webhook-URL cases covered by cli-commands-extended.test.ts; retain distinct secret/options cases.
- [x] Remove client addBulk three-name case covered by client-queue-operations.test.ts; retain types/options/IDs/persistence cases.
- [x] Split by existing describe groups to at most300lines per file. Inventory must show exactly six intentional deletions and no other lost cases/assertions/hooks. Verify surviving counterpart discovery and focused Linux tests.
- [x] In a separately recorded fix delta, strengthen the retained logging, QueueEvents waiting, and forced Worker closure cases: observe stored logs and completion, the emitted job ID, and closure while a started processor remains blocked. Keep all three cases and prove their oracles reject controlled defects.

### Task 3: Observe workflow progress instead of sleeping

**Files:** `scripts/tcp/test-workflow-engine.ts`, `scripts/embedded/test-workflow-engine.ts`.

**Create:** `scripts/shared/workflow-contract.ts`, `workflow-contract-support.ts`, `workflow-contract-basic.ts`, `workflow-contract-control.ts`, `workflow-contract-recovery.ts`, `workflow-contract-operators.ts`, `workflow-contract-observers.ts` under `scripts/shared/` (each at most300lines).

**Interfaces:** Export `runWorkflowContract(mode: 'embedded' | 'tcp'): Promise<{passed:number;failed:number}>`; wrappers preserve standalone process status and runner-compatible summaries. Each mode retains19scenarios.

- [x] Preserve before case/assertion inventory and targeted isolated durations.
- [x] Extract shared mode-parameterized real-engine scenarios, preserving literal expected outputs, ordering, counts and retry/timeout inputs.
- [x] Replace fixed observation sleeps with bounded getExecution polling; wait for waiting before signal, complete all runs before archive, and actual event sets before assertions.
- [x] Install a first-step barrier before subscription can race processing; use a start barrier to prove concurrency without arbitrary processor sleeps.
- [x] Use finally cleanup and fail on teardown errors. Keep real timeout:200, signal timeout1000 and all retry attempts/backoffs.
- [x] Run all19cases per mode in isolated Linux, repeated under reasonable load; record measured durations and prove a missing expected state/event cannot silently pass.

### Task 4: Fast real DLQ and stall maintenance

**Files:** `scripts/shared/advanced-dlq-contract.ts`, `scripts/shared/stall-detection-contract.ts`; their existing TCP/embedded test wrappers if required.

**Create:** `scripts/shared/advanced-dlq-auto-retry-contract.ts` and narrowly needed shared test utilities, each at most300lines.

**Interfaces:** Preserve public runAdvancedDlqContract/runStallDetectionContract results and runner summaries; use existing CoreE2eHarness timer options only.

- [x] Capture isolated before durations and demonstrate the capped helper's impossible expected count.
- [x] Poll exact expected capped DLQ count2 while requiring all3processor invocations and retained values32,33; throw on unmet predicates.
- [x] Run manual maxAge100/expired-count2/purge-count2 against its normal maintenance lifetime. Fully close that queue/manager before creating a separate fast auto-retry broker; CoreE2eHarness.start shuts down shared managers/pools.
- [x] Configure only retry broker dlqMaintenanceMs100; preserve attempts/history/retryCount1/nextRetryAtnull, and observe further opportunities to prove retry stops.
- [x] Configure a test-owned stall broker stallCheckMs100, preserving policy interval200/grace50. Keep stalled workers alive until recovery, assert exact job/event/counters and eventual completion once.
- [x] Shorten heartbeat processor to about1000ms only with fast sweeps and a missing-heartbeat mutant that fails; always release/close resources in finally and expose teardown failures.
- [x] Run both real modes, preserve existing16DLQ/9stall checks or explicitly justify extra checks, and report measured durations separately from estimates.

### Task 5: Integration and final proof

**Files:** root-owned `docs/testing.md`, `docs/features/documented-feature-verification.md`, `docs/README.md`, `docs/architecture.md`, changelog, `feature_list.json`, `progress.md`, this plan.

- [x] Review each task independently (spec and quality); preserve mutation/case inventories and all reports in this plan's ignored workspace.
- [x] Confirm no production/config/SDK/runner diff, no unintended skipped/deleted cases, all changed files within size limit, and update technical docs/changelog/state.
- [x] Stage/freeze candidate; run full sandbox and fresh native Ubuntu serially, compare real totals/times/resources against baseline, read complete logs/anomalies/slow cases. Model/SDK extra gates only if their actual triggers arise.
- [ ] Prove any final docs/state delta, run its readers and init, obtain whole-branch skeptic PASS.
- [ ] Follow existing authorized commit/push/normal PR integration workflow with egeominotti, skeptic before each commit/push, exact-head CI before merge and main CI/local alignment afterward. No version/publication.
