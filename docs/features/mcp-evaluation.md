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

## Standalone MCP regression command

`bun scripts/test-mcp-all.ts` runs the maintained MCP Bun test files under
`test/`, including the real embedded/TCP tool contracts, transport tests,
confirmation controls, and state/counter assertions. It forwards optional Bun
test arguments such as `-t <test-name-pattern>` and propagates the test process's
exit status. SIGINT and SIGTERM are forwarded to that child process.
The child receives only basic OS/terminal settings, plus embedded test mode;
application database paths, broker endpoints, tokens, cloud/provider settings,
and other caller configuration are excluded. Automatic `.env` loading is
disabled for the test process and inherited Bun descendants through the explicit
runtime flag and `BUN_OPTIONS=--no-env-file`, so a caller's persistence aliases
cannot direct these tests into the caller's database. The doctor test helper
reconstructs its child environment and explicitly passes `--no-env-file` to
that real executable as well; it cannot reload broker targets from a caller's
dotenv file after dropping inherited `BUN_OPTIONS`. Run the command inside the isolated
development Machine as required by the repository testing policy.

This command does not infer application success from the absence of an MCP
protocol error. Expected missing-target errors and rejected/ignored transitions
are assertions in their owning suites, with the actual backend state checked
independently. In particular, retired ACK/FAIL attempts must not claim success,
and an explicitly empty retry target must not bypass a declined confirmation.
The command makes no blanket claim that every registered tool has full control
of the broker; discovery counts and the tests actually executed remain visible
in the ordinary test output.

`test/standalone-protocol-runner.test.ts` exercises the executable with a focused
contract selection. Its filename is outside the MCP discovery pattern to avoid
recursively invoking the wrapper from itself. Disposable fixtures and database
cleanup are owned by the maintained tests instead of a shared hard-coded `/tmp`
database.
`test/standalone-protocol-isolation.test.ts` checks all four persistence aliases
against disposable sentinel paths and asserts that the caller files remain
absent after the executable completes. A separate synthetic `.env` fixture runs
the maintained real-bin test and asserts that a nested MCP process also leaves
the caller's sentinel database absent. The doctor fixture selects the maintained
workflow-store inspection test with a synthetic TCP dotenv target, requiring
both a passing real executable check and zero connections to a disposable
loopback sentinel.
