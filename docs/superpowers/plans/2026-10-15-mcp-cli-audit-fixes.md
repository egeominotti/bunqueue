# MCP and CLI Audit Fixes Implementation Plan

> **For agentic workers:** Use the Superpowers debugging, TDD, parallel delegation, review, and verification workflows. The user approved fixing all thirteen previously reported findings. Continue through implementation and validation without another approval checkpoint.

**Goal:** Correct all thirteen findings from the 2.9.15 MCP/CLI audit while preserving existing successful command behavior.

**Architecture:** Keep queue-engine behavior unchanged. Preserve explicit engine outcomes through MCP adapters, validate CLI input before protocol construction, and repair CLI presentation and diagnostics at their existing boundaries. Keep the standalone MCP verification harness separate from product runtime.

**Tech Stack:** TypeScript ESM, Bun 1.4.3, official MCP SDK, MessagePack TCP, SQLite, Bun test, Oxlint/Oxfmt, isolated Ubuntu ARM64 Machines and disposable Docker test containers.

**Spec:** The user-approved thirteen findings are recorded in `artifacts/audit-mcp-cli/bq-mcpcli-mv9rxirh/audit.json`; the behavioral requirements are repeated below so this plan is self-contained.

## Global Constraints

- Preserve user changes. The follow-up authorizes commit and push after the S3
  audit and required checks; version bumps and publication remain unauthorized.
- Keep production and test files at or below 300 lines; split modules by responsibility when necessary.
- Keep all repository content in English and update corresponding internal technical documentation.
- Write and observe failing regression tests before product fixes. Existing isolated audit regressions already demonstrate the MCP and boolean defects; promote them into the normal test suite.
- Use only fresh brokers, dynamic ports, disposable databases, and explicit resource cleanup.
- Run tests in isolated OrbStack Machines, with native arm64 Ubuntu 24.04, 4 CPUs, requested 16 GiB memory and 32 GiB disk, Bun 1.4.3, frozen lockfile.
- Export complete verification logs and environment manifests before deleting disposable Machines.
- Run the model if lifecycle/limits/order/persistence behavior can be affected; run the full Machine and container gates for the final candidate. No SDK source changes are planned.

## Review Focus

- Empty and whitespace retry IDs must never broaden an operation into an unconfirmed bulk retry.
- Mixed applied/ignored batch outcomes must report actual application counts without turning unknown legacy success replies into failures.
- Boolean values and literal arguments after `--` must survive the entire CLI parsing pipeline safely.
- Default long-poll budgets, IPv6 hosts, and structured health failures must work through executable entrypoints.
- DLQ output and monitoring must retain authoritative metadata and valid prototype-like queue names.

## Task 1: MCP confirmation, outcome propagation, and monitoring

**Files:** `src/mcp/tools/dlqTools.ts`, `toolPolicy.ts`, `tools/consumptionTools.ts`, `types/adapter.ts`, `backend/{embedded,tcp}/{jobs,queues,services,monitoring}.ts` as applicable; `test/repro-mcp-audit-contract.test.ts`; `docs/features/mcp-server.md`.

**Interfaces:** Preserve existing engine `AckOutcome`/`AckBatchOutcome` values through `McpBackend.ackJob`, `ackJobBatch`, and `failJob`, or normalize them into equally explicit typed adapter results. Undefined legacy responses mean applied success. Existing structured MCP outcomes already support `not_applied`.

- [x] Run the promoted regression file and record expected failures in both embedded and TCP modes.
- [x] Reject an explicitly empty retry ID or guard it exactly like an omitted bulk target; never bypass a declined confirmation.
- [x] Report ignored ACK/FAIL and batch items accurately, including mixed batches, while preserving legacy successful response fields.
- [x] Preserve a valid `__proto__` queue as an own enumerable monitoring property.
- [x] Add successful/legacy/mixed-batch control cases, update internal MCP documentation, run focused MCP suites, and obtain independent review.

## Task 2: CLI safety and input parsing

**Files:** `src/cli/commands/{core,backup,queue,types}.ts`, `src/cli/globalOptions.ts`, narrowly scoped parsing helpers if needed; `test/repro-cli-audit-inputs.test.ts` and existing relevant parser regressions. Parent owns the shared CLI technical document.

**Interfaces:** Continue returning existing protocol command records from `buildCommand`. Boolean flags must never interpret string `false` as true. Preserve the command-level `--` marker through `parseGlobalOptions` so the downstream parser can protect literal arguments.

- [x] Run failing boolean, state-filter, and complete-parser regressions before implementation.
- [x] Parse explicit boolean values safely or reject unsupported values before any restore/mutation; cover deletion flags, LIFO, and restore force.
- [x] Accept canonical listing states `prioritized`, `paused`, and `waiting-children` with real broker-backed coverage.
- [x] Preserve literal option-looking positional text through the whole CLI pipeline; adjust old tests that asserted only a broken intermediate representation.
- [x] Verify ordinary flag aliases, negative JSON, numeric boundaries, parser invariants, and actual protected log writes; obtain independent review.

## Task 3: CLI results, diagnostics, health JSON, and guidance

**Files:** `src/cli/client.ts`, `src/cli/{index,localOutput,help}.ts`, `src/cli/commands/{doctor,healthcheck,job}.ts`, `src/cli/output/{success,collections}.ts`; `test/repro-cli-audit-runtime.test.ts` and relevant CLI tests. Parent owns shared CLI documentation.

**Interfaces:** Keep text healthcheck behavior unchanged by default; JSON mode emits one machine-readable result on the appropriate stream. Diagnostic health URLs must bracket bare IPv6 addresses. Existing command response shapes remain compatible.

- [x] Observe failing real-broker DLQ/default-wait/health/IPv6/progress/guidance cases.
- [x] Render DLQ error and entered/failure time from authoritative entries, retaining compatibility with legacy jobs-only responses.
- [x] Give an omitted `WaitJob` timeout the same network allowance as an explicit broker-default timeout.
- [x] Fix doctor/version URL construction for IPv6, and cover already bracketed hosts where accepted.
- [x] Honor `healthcheck --json` for both success and failure without leaking URLs or credentials.
- [x] Support the documented `--msg` progress alias or replace documentation consistently; replace nonexistent processor startup guidance with an existing supported worker mechanism.
- [x] Run targeted executable and formatter regressions and obtain independent review.

## Task 4: Standalone MCP verification correctness

**Files:** `scripts/test-mcp-all.ts`, focused modules under `scripts/mcp-all/` if needed; a regression covering the real grading behavior; `docs/features/mcp-evaluation.md` and related internal testing documentation.

**Interfaces:** Classify expected negative cases explicitly. Ordinary mutation success requires an applied/success outcome, not merely absence of a protocol error. Read-only responses and intentionally ignored/negative probes must have their own expected results.

- [x] Add a failing regression demonstrating false pass for a non-applied mutation and false failure for an expected missing target.
- [x] Correct response classification, remove misleading blanket success claims, and ensure helper subprocesses are bounded and cleaned up.
- [x] Keep the touched standalone runner and extracted modules at or below 300 lines.
- [x] Run the script against a fresh embedded backend and verify expected negatives and declined mutations cannot be misgraded.

## Task 5: Integration, documentation, review, and final verification

**Files:** `docs/features/cli.md`, any affected internal MCP/testing references, regression fixtures, and final review fixes only.

- [x] Integrate all four task results and update CLI documentation for every externally visible fix.
- [x] Run typecheck, focused regression/invariant suites, lint/format, and `git diff --check`; review the entire uncommitted diff independently.
- [x] Run `bun run test:model` because confirmation and mutation-adapter changes affect observable lifecycle outcomes.
- [x] Transfer a sanitized final worktree snapshot to a fresh Ubuntu ARM64 Machine, provision Bun 1.4.3 and frozen dependencies, build portable client prerequisites, then run unit, TCP, embedded, typecheck, and OXC checks.
- [x] Run `bun run test:sandbox` against the final host worktree, inspect complete suite logs, totals, resource telemetry, anomalies, and retained containers on failure.
- [x] Resolve any verified failure with a regression and rerun the affected gate. Export logs/manifests, delete only task-created Machines/containers, and report exact results and any remaining limitations.

## Final verification record

All thirteen audited findings and all final-review findings are resolved. The fresh native Ubuntu ARM64 gate passed 11,570 unit tests, 499 TCP cases, 342 embedded cases, 571 standalone MCP cases and nine tiny-filesystem cases. The canonical parallel container gate passed 11,440 unit tests, 499 TCP cases and 342 embedded cases. Both unit gates retain 316 conditional skips. Static checks passed with 14 existing source-lint warnings and no errors. Earlier diagnostic failures and their bounded investigations remain documented; no worker/runtime assertions were weakened.

Complete commands, logs, resource telemetry, review reports, limitations and cleanup records are preserved under `artifacts/mcp-cli-fixes/`, with the final summary at `artifacts/mcp-cli-fixes/verification.md`. At that original handoff, changes were uncommitted and no push, version bump or publication had been performed.

## Authorized follow-up: S3 audit, commit and push

The user subsequently requested commit/push and added an S3 audit. These instructions
authorize the final Git operations and extend the existing bug-fix scope; earlier
statements about missing commit authorization describe the previous handoff only.
No version bump or publication is authorized.

### Task 6: Deterministic S3 retention

- [x] Reproduce deletion of the newer timestamped payload and metadata when S3
  returns identical `LastModified` values (isolated RED: 2 pass, 1 fail).
- [x] Sort by modification time, then descending object key; preserve legacy
  modification-time precedence and document the tie breaker (GREEN: 3 pass).
- [x] Obtain independent task review (specification and quality PASS).

### Task 7: S3 service-error classification

- [x] Exercise real Bun S3 requests against a loopback endpoint; observe missed
  `SlowDown`/`InternalError` retries and spurious `AccessDenied` retries (3 failures).
- [x] Classify service errors by code before legacy message fallback, preserving
  bounded retry behavior and terminal local timeouts for uncancellable operations.
- [x] Verify the regressions and existing S3 timeout/retry coverage; update the
  reliability contract and obtain independent task review.

### Task 8: Interrupted SQLite restore

- [x] Kill a writer after a committed WAL-only row, then kill restore after WAL
  quarantine; observe the committed row missing when the old database reopens.
- [x] Make original committed state recoverable before detaching sidecars, and
  refuse installation if that preparation cannot complete safely.
- [x] Verify interruption, successful restore, rollback and corrupt-candidate
  paths; document recovery semantics and obtain independent task review.

### Task 9: Verify and integrate the final candidate

Validation follow-up: the unchanged pull-cadence regression failed twice in fresh
native unit runs (8 and 9 pulls against a 10-pull/300 ms threshold), including once
after the container load had ended. A narrow run passed. Before repeating the
final gates, replace throughput assumptions with observations of actual requested
poll delays across repeated cycles. Preserve transient 10/50 ms scheduling,
permanent exponential backoff and quiet/error behavior; prove that wrong-backoff,
zero-delay and wrong-delay mutants still fail. No queue runtime change, lowered
threshold or arbitrary longer sleep is part of this correction.

- [x] Preserve the failing native logs and diagnose the fixed-window assumption.
- [x] Make cadence assertions deterministic and prove callback-jitter tolerance
  plus rejection of deliberately incorrect scheduling in isolated copies.
- [x] Obtain independent test-contract review before the final gate repeat.
- [x] Apply the same proven correction to the adjacent quiet-pull regression:
  all three refusal reasons, eight exact 50 ms decisions each, normal and late
  delivery, continued progress and no emitted errors. Independent review passed;
  wrong-backoff and error-emission mutants fail their intended assertions.
- [x] Compile every changed TypeScript file, including tests and MCP. Repair
  fixture/helper type mismatches without weakening assertions; verify unchanged
  emitted JavaScript for the erased cadence and stream-helper type corrections.

- [x] Run combined S3 regressions, backup/lifecycle models, static checks, a fresh
  native Ubuntu ARM64 full gate and the canonical parallel container gate.
- [x] Update the changelog for MCP, CLI and confirmed S3 fixes without a version bump.
- [x] Stage only the intended source, tests and documentation and export the
  complete native and container verification evidence.

Git completion requires a complete staged skeptic PASS before commit and a
separate skeptic PASS before push. Verify each outgoing commit's English message
and corresponding changelog, push normally, verify the remote hash and delete
only task-created Machines after final evidence export. Record those operation
results in the ignored execution ledger and verification artifacts.

### Final follow-up verification record

The final candidate contains 60 intended files, including 51 TypeScript files at
or below 300 lines. All production source and script hashes match the earlier
passing S3 candidate; subsequent corrections affect validation fixtures only.
Retention, service retries, interrupted restore and both deterministic timer
corrections passed independent specification and quality reviews.

Fresh Ubuntu 24.04.5 ARM64 with Bun 1.4.3+c6da4a4d3 passed all 20 native checks:
11,595 unit cases, 499 TCP cases, 342 embedded cases, 571 standalone MCP cases
and nine disk-full cases. The final default parallel Docker gate passed 11,465
unit cases, 499 TCP cases and 342 embedded cases. Both unit gates retain 316
conditional skips. Builds, explicit compilation of MCP and all changed tests,
lint and format passed; 14 source-lint warnings are pre-existing in unchanged
files. Container telemetry reports no anomalies or OOM events, with peak unit
memory 1.77 GiB of 4 GiB. Slowest cases exercise documented expiry, polling and
model workloads.

Earlier failing or cancelled attempts remain recorded as such. A Docker U3
startup timeout passed exact-image narrow controls and the complete canonical
repeat; discarded child output prevents establishing its historical cause. The
failed container is retained. No production change was made for that diagnosis.

Complete follow-up evidence is under `artifacts/s3-audit/mv9w0qp3/`, including
`verification.md`, native manifests, full logs, resource telemetry and reviews.
S3 probes use the actual Bun client against disposable loopback endpoints with
placeholder credentials. External PostgreSQL, optional packed Node declarations,
native amd64 CI and Debian release validation remain outside the local gate;
no SDK source change requires the external SDK gate. Package version remains
2.9.15; no publication is authorized.
