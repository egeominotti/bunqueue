# Agent experience without queue-core changes

The approved work improves how agents inspect and operate bunqueue through MCP and
how applications connect agent SDK turns to durable workflows. Queue scheduling,
job transitions, locks, persistence/recovery and workflow execution are unchanged.

## Boundaries

- Modify MCP, optional agent integration modules, examples, tests and documentation.
- Do not modify `src/application`, `src/domain`, `src/infrastructure`,
  `src/client/workflow`, queue/worker/transport internals or external `sdk/` code.
- Preserve existing tool names, text response shapes, default confirmation behavior,
  job scheduling semantics and `wait_for_job` completion semantics.
- Add no runtime dependencies. All new source files remain at most 300 lines.
- No commits, pushes, version changes or publication are authorized.

## Deliverables

1. Correct diagnostic prompt accounting and include queue limits. Add a read-only
   `bunqueue_diagnose_queue` returning complete counts, observed blockers, bounded
   samples, observation time and suggested inspection tools. A snapshot alone must
   not claim starvation, growth, stalled work or absent registered workers as fact.
2. Every MCP tool advertises an output schema and returns structured results while
   retaining its legacy text response. Structured outcomes distinguish success,
   not-applied, confirmation-required and error; errors carry stable classifications
   and conservative retry guidance. Unknown write outcomes never recommend blind retry.
3. Add `bunqueue_observe_job` for terminal-state observation, including state,
   progress, result/failure detail, timeout and cancellation. Read existing backend
   methods only. Existing `wait_for_job` remains unchanged.
4. Add bounded `bunqueue_list_jobs_page` with `limit` 1..100, offset, `hasMore`,
   next offset, data projection and payload truncation metadata. Keep legacy listing
   semantics. Bound broad prompt/resource output and provide scoped resource access.
5. Always expose policy annotations, including dynamic descriptors. Add an explicit
   `BUNQUEUE_MCP_PROFILE=agent` preset for dynamic discovery and destructive confirmation,
   with explicit settings taking precedence. Add a read-only capabilities tool and
   MCP doctor path that reports configuration and connection readiness without writes.
6. Add optional provider-neutral agent-turn helpers and a separate SQLite journal:
   per-execution/step session checkpoints, stable tool-effect keys, explicit uncertain
   outcomes/reconciliation, cooperative abort, normalized terminal results, output
   validation and bounded replayable progress events. It must not promise exactly-once
   external effects or persist credentials/full prompts by default. Correct the Claude
   and OpenAI examples to use local run state and handle non-success outcomes.
   The journal must identify/version its own schema and refuse an existing foreign
   SQLite database before changing pragmas or creating tables.
7. Add offline real-MCP task evaluations with isolated embedded/TCP scenarios for
   diagnosis, paging, observation and approval. Score observed task outcomes and tool
   calls, not only routing. Provide an optional LLM driver boundary and metrics for
   calls, latency, response size and usage when provided; do not invoke paid APIs.
8. Update internal technical references, public guides, onboarding and the public
   bunqueue skill. Expose workflow/agent guidance in the LLM documentation index.

## Validation

Regressions precede fixes. Iterate in an isolated development OrbStack Machine.
Run a fresh native arm64 Ubuntu 24.04 Machine gate and `bun run test:sandbox`,
plus typecheck, Oxc checks and `git diff --check`. Run `bun run test:model` whenever
a change can affect lifecycle/order/persistence; read-only observation and the new
independent journal will additionally be covered by this gate conservatively.
Review full logs, resource anomalies and slow tests. Preserve all evidence under
ignored `artifacts/`. Verify the forbidden core paths have no diff at handoff.
