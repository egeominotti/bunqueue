# Agent Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Improve MCP agent ergonomics and durable SDK integrations without changing the queue core.

**Architecture:** Add observation, diagnosis and bounded inspection at the MCP boundary. Normalize results centrally and add an independent optional agent journal; continue to consume the existing public queue/workflow APIs.

**Tech Stack:** Bun 1.4.3, TypeScript ESM, MCP SDK, Zod, optional `bun:sqlite` journal.

**Spec:** `docs/superpowers/specs/2026-10-14-agent-experience-design.md`

## Global Constraints

- Forbidden edits: `src/application`, `src/domain`, `src/infrastructure`, `src/client/workflow`, queue/worker/transport internals, external `sdk/`.
- Preserve legacy text response shapes, default destructive-call execution and existing scheduling semantics.
- No new runtime dependencies; source files at most 300 lines; English repository content.
- No commits/pushes/publication. Use isolated Linux tests; retain reports in `artifacts/`.

## Review Focus

- Failed, removed and auto-removed jobs must never appear falsely completed or safely retryable.
- Rate-limited or dependency-blocked work must not be described as proven stuck.
- Confirmation previews and dynamic dispatch must preserve guards and structured outputs.
- Agent cancellation/crash must not silently succeed or blindly repeat an uncertain effect.
- Replay pruning and pagination must reveal omitted data and preserve deterministic progression.

---

### Task 1: Accurate diagnosis, terminal observation and bounded inspection

**Files:**
- Modify: `src/mcp/prompts.ts`, `src/mcp/resources.ts`, `src/mcp/toolSetup.ts`, `src/mcp/toolPolicy.ts`.
- Create: focused `src/mcp/tools/observationTools.ts`, `src/mcp/diagnostics.ts`, `src/mcp/inspectionPage.ts` and resource/prompt helpers as needed.
- Test: `test/repro-mcp-diagnostics.test.ts`, `test/mcp-agent-observation.test.ts`.
- Docs: `docs/features/mcp-server.md`, `docs/data-model.md`.

**Interfaces:**
- Consumes existing `McpBackend` read APIs; do not extend or change backend engine contracts.
- Produces registered tools `bunqueue_diagnose_queue` (monitoring), `bunqueue_observe_job` (jobs), `bunqueue_list_jobs_page` (queues).
- Observation arguments: `jobId`, optional `timeoutMs` 0..30000 and `pollIntervalMs` 25..1000. Forward MCP request abort, return explicit `state`, `terminal`, `timedOut`, `progress`, `result`/`failure`, `nextPollMs`.
- Page arguments: `queue`, optional supported `state`, `offset` >=0, `limit` 1..100 (default20), `includeData` default false; return `jobs`, `count`, `hasMore`, `nextOffset`, projection/truncation metadata. Probe one extra row; do not change legacy get_jobs.
- Diagnosis reports `observedAt`, complete counts/total, limits, `blockers`, bounded active/delayed/waiting-children samples and `suggestedTools`; unknown causes remain unknown.

- [x] Add actual MCP prompt regressions for prioritized/paused/waiting-children totals and limits. Run and record expected failures before investigating fixes.
- [x] Add public MCP tests for completed/failed/delayed/unknown observation, timeout, abort, empty result, bounded pages and no data leakage.
- [x] Implement read-only helpers and tools; use bounded samples without mutating scheduling or leases.
- [x] Update prompts/resources with full accounting, bounded output and scoped resource templates.
- [x] Pass targeted tests in development Machine and document contracts.
- [x] Obtain independent task review; fix important findings.

### Task 2: Structured results, metadata, preset and doctor

**Files:**
- Modify: `src/mcp/toolSetup.ts`, `src/mcp/toolsets.ts`, `src/mcp/confirmGuard.ts`, `src/mcp/serverFactory.ts`, `src/mcp/index.ts` as needed.
- Create: `src/mcp/toolResults.ts`, `src/mcp/resultSchemas.ts`, `src/mcp/agentProfile.ts`, `src/mcp/doctor.ts`, capabilities tools.
- Test: `test/mcp-agent-contract.test.ts`, existing policy/toolset/guard/settings tests.
- Docs: `docs/features/mcp-server.md`, `docs/data-model.md`.

**Interfaces:**
- Consumes Task1 registrations. Adds `bunqueue_get_capabilities` in monitoring.
- Produces structured envelope `{ outcome, data, error?, suggestedAction? }`; outcome is success/not_applied/confirmation_required/error. Text stays legacy-compatible. Typed common payload schemas plus a generic object fallback cover all tools, including discovery/guards.
- Stable errors distinguish missing target, invalid input, rejected transition, cancellation, backend/provider unavailable and unknown. Never infer a write is retryable solely from an error string.
- `BUNQUEUE_MCP_PROFILE=agent` supplies dynamic toolsets and destructive confirmation only when their env values are absent. Invalid profile fails startup; defaults unchanged without it.
- `bunqueue-mcp --doctor` reports mode/profile/transport, persistence/configured workflow capability, backend connectivity and available toolsets without starting consumers or performing writes; support JSON output and meaningful exit code.

- [x] Write failing public MCP tests for structured success/error/not-applied/confirmation and dynamic dispatcher results.
- [x] Test default annotations and dynamic descriptor annotations/output schemas; update the intentional old metadata contract while preserving guard behavior tests.
- [x] Implement central normalization after guards and discovery wiring so every result is covered exactly once.
- [x] Test preset precedence and doctor subprocess success/configuration failure with a fresh broker.
- [x] Pass focused tests/typecheck and document configuration/contracts.
- [x] Obtain independent task review; fix important findings.

### Task 3: Optional durable agent-turn integration

**Files:**
- Create: `src/agents/` with focused types, turn consumer, journal, effects and progress modules, exported through `src/agents/index.ts`.
- Modify: `package.json` only for the optional `./agents` export; `scripts/agent-sdks/claude-agent-live.ts`; public SDK guide examples.
- Test: `test/agent-turn.test.ts`, `test/agent-journal.test.ts`, SDK example regression tests.
- Docs: new `docs/features/agent-integrations.md`, `docs/README.md`, `docs/architecture.md`, `docs/data-model.md`, SDK guide.

**Interfaces:**
- Independent `AgentJournal` backed by its own SQLite file, never the workflow DB. Keys are `executionId` + step/idempotency identity.
- Validate journal ownership/schema version before opening/querying an existing SQLite file; reject foreign queue/workflow databases unchanged, including no new WAL/SHM sidecars for dormant WAL databases.
- `consumeAgentTurn` accepts an async iterable normalized provider events, optional signal, schema parser, journal/run identity; checkpoints session events before consuming the next event and throws typed failures on interrupted/non-success streams.
- Events include session, progress/tool lifecycle, usage and terminal success/failure/cancelled/needs_input. Bounded journal replay uses monotonic cursor and explicit retention-gap metadata. Cap event bytes and exclude raw prompts/secrets by default.
- Effect helper persists pending before external operation and completion after it, returns prior completed results, refuses uncertain repeats unless a caller reconciliation callback proves outcome. Derive stable idempotency keys from run+step+call identity.
- SDK wrappers use provider cancellation APIs and local effect state. Output validation uses `.parse()` without mandatory provider imports.

- [x] Add failing regressions for Claude non-success terminal messages, missing final message and concurrent effect isolation before fixes.
- [x] Test new journal close/reopen, per-run isolation, foreign-database refusal, pending effect reconciliation, bounded replay/cursor gaps, abort and output validation against real SQLite.
- [x] Implement independent modules and provider mapping helper(s), no workflow/worker internals changes.
- [x] Correct documented/live examples to consume terminal outcomes, checkpoint session and forward existing ctx.signal; demonstrate progress replay and uncertainty handling.
- [x] Pass targeted tests plus test:model conservatively; document limitations of provider idempotency and session artifact locality.
- [x] Obtain independent task review; fix important findings.

### Task 4: Task evaluations and onboarding

**Files:**
- Create: focused `scripts/mcp-eval/task-scenarios.ts`, `task-eval.ts` and supporting driver/report modules.
- Test: `test/mcp-task-eval.test.ts`.
- Modify: `README.md`, `docs/src/content/docs/guide/mcp.mdx`, workflow/agent guides, `docs/public/llms.txt`, `skills/bunqueue/SKILL.md`, `skills/bunqueue/mcp.md` and focused workflow reference.
- Docs: internal MCP/agent documents and evaluation README/results description.

**Interfaces:**
- Offline driver exercises actual MCP client and fresh embedded/TCP backends; no paid model call by default.
- Scenarios own unique queues/DBs and cleanup. Assertions independently verify final state, guard non-execution, accurate blockers and complete bounded paging.
- Report scenario outcomes, calls, elapsedMs, responseBytes and optional supplied token/usage metrics; routing success is not task success. Expose driver interface for opt-in external agents without assuming deterministic planned scripts are LLM evaluations.

- [x] Write failing tests for evaluation pass/fail aggregation and observable real-MCP scenarios.
- [x] Implement offline harness and driver interface; execute embedded/TCP scenario evaluation.
- [x] Update onboarding with preset, doctor, structured results, observation, scoped reads and optional agent-turn journal.
- [x] Measure current catalog/disclosure bytes and update or label older token estimates that predate output schemas; never claim deterministic-driver scores are LLM success rates.
- [x] Shorten public skill entrypoint and add progressive workflow/agent reference links; pressure-test its guidance without real external actions.
- [x] Add workflow/agent and full-text documentation links to LLM index.
- [x] Obtain independent task review; fix important findings.

### Task 5: Integrated review and isolated final gates

- [x] Verify forbidden core paths have no changes; all created source files at most300 lines.
- [x] Run focused regression suites, typecheck/Oxc and `bun run test:model` in development Machine.
- [x] Obtain broad independent code review; fix critical/important findings and re-review.
- [x] Run host `git diff --check`, create sanitized final snapshot, run fresh isolated native Ubuntu24.04 Machine full unit/TCP/embedded/typecheck/Oxc gates.
- [x] Run `bun run test:sandbox`; review complete logs, NDJSON samples, anomalies, exact totals and slow-test rankings.
- [x] Copy manifest/logs to artifacts and delete Machines; report changes/results without committing.
