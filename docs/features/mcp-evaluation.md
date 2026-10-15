# MCP Task Evaluation

The modules in `scripts/mcp-eval/` separate functional task checks from historical
toolset routing evidence. `task-eval.ts` runs five tasks in fresh embedded and
TCP fixtures by default; no provider SDK/model/key is used. Each fixture owns a
temporary SQLite directory, unique queue and dynamic TCP port when needed.
It constructs the production MCP server factory and a real MCP SDK client over
linked in-memory transports. This checks tool semantics/backend parity, rather
than stdio/HTTP session behavior, which separate transport tests cover.

## Modules and contracts

| Module | Responsibility |
| --- | --- |
| `task-types.ts` | Driver/context/output, per-task check/result, mode and call-record types |
| `task-harness.ts` | Real client/server/backend, full serialized response byte count, target trace, cleanup |
| `task-scenarios.ts` | Fixture setup and independent backend/result assertions |
| `offline-driver.ts` | Hand-written task scripts using public tools only |
| `task-eval.ts` | Sequential scenarios, failure/cleanup capture, aggregation and CLI exit status |
| `catalog-measurement.ts` | Complete tools/list and actual disclosure serialization measurements |

The five tasks verify retained null-result completion/accounting; permanent
failure versus unknown; all five IDs exactly once over bounded two-row pages
and oversized limit refusal; observed pause/delay/concurrency configuration with
accurate accounting/blockers; and confirmation preview with all jobs intact.
The evaluator reads the actual backend after execution independently of the
driver's claimed success. Tool responses supply observed terminal/page/diagnosis
evidence. Dynamic fallback calls trace their actual target. A no-op driver or
driver exception fails the task; subsequent scenarios still run. Exception
occurrence is tracked independently of diagnostic text: an empty Error message
or thrown empty string still fails even when all state checks pass. Empty text
is preserved in the result's error field rather than interpreted as success. Any failed
scenario or empty evaluation yields aggregate exitCode 1; the CLI propagates it.

`TaskDriver.run(TaskContext)` receives request/queue/job IDs and call/list methods,
but no backend handle. Its output can supply optional token/cost metrics. An
external driver must be implemented and explicitly selected by a separate caller;
this interface itself is not a provider integration or LLM measurement. Scenario
fixtures/expectations are transparent, so deterministic scores cannot estimate
LLM generalization or task success rates. The driver controls its own provider
deadlines/cancellation. The harness is sequential and requires no active shared
embedded manager; never run it inside an application using that singleton.

Response bytes count compact UTF-8 JSON of complete MCP tools/list/tools/call
results, including structured data and legacy text. Tool-call count excludes
listTools. Elapsed time includes fixture construction and cleanup, not provider
benchmarking. Catalog measurement includes full descriptions/annotations/input
and output schemas. Current default primary count is 79; optional workflows add
2 inspection tools and a third TCP signal tool only in supported topology.
Dynamic discovery adds 2 (plus find_tools only with a configured decision model),
reported separately. Approximate tokens use ceil(bytes/4), not a tokenizer.

Run `bun scripts/mcp-eval/task-eval.ts` and
`bun scripts/mcp-eval/catalog-measurement.ts`; see
[README](../../scripts/mcp-eval/README.md) and
[current/historical results](../../scripts/mcp-eval/RESULTS.md).
Regression coverage: `test/mcp-task-eval.test.ts` and
`test/mcp-catalog-measurement.test.ts`. Final product suites remain mandatory;
these focused offline checks supplement them.
