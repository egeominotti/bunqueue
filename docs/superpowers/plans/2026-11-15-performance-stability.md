# Performance Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the monitoring and MessagePack optimizations with unchanged tests and isolated stability evidence, while retaining scalar SQLite durable admission after the safety assessment.

**Architecture:** Keep SQLite durable admission on its existing scalar path. Aggregate monitoring counts locally while preserving callback observations, and replace only the MessagePack byte scan with a bounded native search while retaining existing decoder selection and safe materialization.

**Tech Stack:** Bun 1.4.4, TypeScript ESM, bun:sqlite, msgpackr, Docker and OrbStack.

**Spec:** [Approved scope](../specs/2026-11-15-performance-stability-design.md).

**Safety ruling after Task 1 assessment:** retain SQLite runtime unchanged.
Transaction grouping cannot preserve the durable successful prefix under
permanent failure after rollback. Task 1 closes with evidence and a deferred work
item; only Tasks 2 and 3 deliver runtime changes. This follows the user's stability
requirement, and does not approve a weaker durability or partial-failure contract.

## Global Constraints

- All existing tests, fixtures and test support files stay byte-identical. No test is added, removed, skipped, weakened or excluded.
- Commit, push and merge to main are now user-authorized, including the engineering article/report. Version bumps and package publication remain unauthorized.
- Retain public APIs, protocol, schema, durability configuration, ordering and scheduling semantics.
- Source files remain at most 300 lines. Every source change updates its internal feature documentation and changelog.
- Product code must not acquire test hooks.
- Use bun check and bun fmt exclusively for type and format checks.
- Implementers own only task files, do not dispatch subagents, and do not edit state files.
- Existing user approval covers execution; do not request another plan approval.

## Review Focus

- SQLite persistence precedes publication, including prefixes and transaction errors: Task 1 fault probes and unchanged durable/disk-full tests.
- Accessors, proxies and serializers retain behavior or stay on the scalar path: Task 1 eligibility probes.
- Crash recovery conserves acknowledged admissions and counters: Task 1 child-process probes.
- Dashboard callbacks can mutate live state: Task 2 event and time-boundary oracle.
- Byte views and prototype keys retain bounded safe decoding: Task 3 existing security tests and diagnostic oracle.

### Task 1: SQLite safety assessment (completed; grouping deferred)

**Historical candidate files:** pushBatch.ts and SQLite admission helpers. No SQLite production file or API is changed. Comparative evidence lives in ignored artifacts/perf-stability/sqlite/.

**Interfaces:** Consume existing PushContext, createJob, preparation/publication helpers and SQLite safe-write accounting. Produce narrow plain durable admission with scalar fallback, no public API or schema changes; document exact internal interfaces in the report.

- [x] Read/run the unchanged focused baseline diagnostics:56 pass,0 fail, including real disk-full cases.
- [x] Establish20 comparative success/fault and8 crash probes using real SQLite and the original prototype, preserving returned/RAM/durable IDs, counters, events, errors and recovery evidence.
- [x] Assess successful-prefix equivalence, nested accessors/proxies, transaction failures, automatic rollback and closed-connection recovery. Record divergences without claiming equivalence.
- [x] Reject transaction grouping under the current contract; independent architectural review confirms the limitation. Keep SQLite scalar runtime unchanged.
- [x] Track redesign separately as performance-durable-batch-contract. Retain reports/probes without altering tests or shipping prototype-only interfaces.

### Task 2: Monitoring active-count aggregation

**Files:** src/application/monitoringChecks.ts; docs/features/background-tasks.md; changelog [Unreleased]. Read/run only test/repro-config-monitoring.test.ts and test/repro-monitoring-production.test.ts. Driver/logs: ignored artifacts/perf-stability/monitoring/.

**Interfaces:** Consume unchanged processing maps and MonitoringContext. Produce identical events and state with one lazy count aggregation per event-free idle pass.

- [x] Read/run the unchanged monitoring tests and inspect the prototype.
- [x] Aggregate counts locally; invalidate after each emitted idle callback so later queues see mutations. Preserve waiting runAt <= now, separate phase clocks, event order and disabled paths.
- [x] Run existing tests and differential callback/time-boundary/disabled oracles.
- [x] Update docs/changelog, type/format-check and report for review without committing.

### Task 3: Native bounded MessagePack search

**Files:** src/shared/msgpack.ts; docs/features/client-transport.md; changelog [Unreleased]. Existing tests read/run only: byte views, typed arrays, prototype safety, CLI protocol boundaries. Driver/logs: ignored artifacts/perf-stability/msgpack/.

**Interfaces:** Consume/produce identical encodeMessagePack and decodeMessagePack values, exceptions and safe own properties.

- [x] Read/run existing tests and inspect the prototype.
- [x] Replace only byte-pattern search using Buffer.indexOf on a zero-copy view bounded by input byte offset and length.

The search implementation is:

```typescript
function containsProtoKey(buffer: Uint8Array): boolean {
  return (
    Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).indexOf(PROTO_KEY_BYTES) !==
    -1
  );
}
```

- [x] Run existing security/byte-view tests and differential empty/truncated/subarray/prototype-key oracles.
- [x] Update docs/changelog and type/format-check; report for independent review without committing.

### Task 4: Final integration and gates (controller owned)

- [x] Review each task independently and resolve important findings before the next task.
- [x] Verify1558 immutable test/fixture/runner hashes and no added tests.
- [x] Re-run140 native A/B samples plus20 discarded warmups with correctness checks and raw variance.
- [x] Run full type/format/init and isolated model12/0,100418assertions.
- [x] Freeze/stage candidate tree3271985cfb92e861756bc4c887d38b77b9922719.
- [x] Pass full product sandbox11931/0/404,TCP553/0,embedded349/0; SDK1557/0/3; fresh Ubuntu12062/0/404,TCP553/0,embedded349/0,tinyfs9/0. No resource anomalies; Machine deleted.
- Whole-change reviewer found no introduced source defect; final gate/closure verification is recorded in artifacts/perf-stability/final-verdict.txt.
- Exact local evidence is in the work item and artifacts/perf-stability/closure.json. The user has authorized commit/push/merge and the article/report; keep the item in progress until source CI and integration close. Package version/publication remain unchanged.
