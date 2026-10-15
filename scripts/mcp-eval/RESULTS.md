# MCP evaluation results

## 2026-10-14: current offline functional tasks

`bun scripts/mcp-eval/task-eval.ts` uses the hand-written `offline-deterministic`
driver over real production MCP tools and fresh embedded/TCP SQLite backends.
Five scenarios per backend passed independent final-state/count assertions:
retained null-result completion, permanent failure/unknown, complete bounded
pages and invalid-limit refusal, observed diagnosis/limits, guard non-execution.
This is **offline functional evidence**, not an LLM success rate. No provider,
model selection, credentials or paid calls were used. No-op/throwing drivers and
dynamic fallback dispatch are covered by the evaluation regression tests.

Measured on the native arm64 Ubuntu 24.04 isolated development Machine with
Bun 1.4.3+c6da4a4d3. These are targeted iteration results, not final full-suite
or release evidence. Commands and JSON output are retained in
`artifacts/agent-experience/task4-*` for this worktree. See [README](README.md).

## 2026-10-14: complete current catalog/disclosure context

`bun scripts/mcp-eval/catalog-measurement.ts` measured UTF-8 bytes of compact
complete JSON tools/list results and actual tools/call disclosure responses.
Descriptions, input/output schemas and annotations are included. Estimated
tokens use ceil(bytes/4), **not a model tokenizer**. Client retention of text,
structured content and refreshed lists varies; disclosure cost is separate from
the next tools/list size. Earlier ~16,000/~850 estimates omitted output schemas.

| Surface | Tool count | Bytes | Approx. tokens |
| --- | ---: | ---: | ---: |
| Default primary tools/list, no profile/workflow | 79 | 144,912 | 36,228 |
| Agent profile, initial dynamic discovery | 2 | 5,264 | 1,316 |
| Agent catalog + one default group (range) | 6–15 | 11,185–31,267 | 2,797–7,817 |
| Optional workflow descriptors, embedded | +2 (81 total) | 4,266 | 1,067 |
| Optional workflow descriptors, supported TCP | +3 (82 total) | 6,659 | 1,665 |

Dynamic discovery adds two descriptors; optional decision-model `find_tools`
adds another only when configured. It was not configured/called in this run.
Workflow descriptor bytes above include their own `{ tools }` wrapper, rather
than subtracting two full catalogs.

| Loaded group | Complete next tools/list bytes | Actual disclosure response bytes |
| --- | ---: | ---: |
| jobs | 31,267 | 82,862 |
| job-control | 16,036 | 33,504 |
| processing | 20,025 | 46,350 |
| queues | 24,798 | 64,280 |
| dlq | 13,799 | 27,852 |
| cron | 15,076 | 30,307 |
| limits | 13,482 | 26,869 |
| flows | 24,502 | 63,707 |
| workers | 15,744 | 34,352 |
| webhooks | 11,185 | 19,645 |
| monitoring | 18,363 | 43,023 |

Optional workflow dynamic disclosure measured separately: 13,195 bytes embedded
(2 tools), 20,470 bytes TCP (3 tools). Embedded signal omission prints its
expected topology diagnostic. Historical model/lexical routing below remains
historical routing evidence; it was not rerun or promoted to task success.

## Historical toolset routing results

Dataset: `toolset-routing.json` (72 requests: 36 development, 36 held-out). A
request counts as routed when the chosen toolset contains one of its labelled
tools. Re-run the model measurement with
`bun scripts/mcp-eval/toolset-routing.ts` (decision-model environment set) and
the lexical baseline with `--lexical`.

## 2026-10-02, TypeSafe Jev `jev-1.13.0`, 11 always-on toolsets

Measured with TypeSafe's `jev_classify` tool, using the toolset catalog of
`src/mcp/toolPolicy.ts` as the classes (the same model and catalog that
`bunqueue_find_tools` uses; the question wording differs from
`FIND_TOOLS_QUESTION`), one request per item.

| Run | Catalog | Development | Held-out |
| --- | --- | ---: | ---: |
| 1 | `queues`: "count and list jobs by state" | 36/36 | 35/36 |
| 2 | `queues`: "count and list a queue's jobs in any state (waiting, delayed, active, completed, failed)" | 36/36 | 36/36 |

- Run 1's miss: "list the failed jobs in the webhooks queue, page 2", labelled
  `get_jobs` (`queues`), went to `dlq` with probability 0.51 against 0.48. The
  label is debatable: jobs that exhausted their retries are in the DLQ, so
  `get_dlq` is a defensible answer. The `queues` description was changed to name
  every job state after seeing this miss, so run 2's held-out score is not a
  blind result.
- Both runs flagged two correct answers as low-confidence: "the job crashed with
  timeout, record the failure" (`processing`, 0.84 then 0.83) and "process every
  job in the notify queue by POSTing it to my API" (`workers`, 0.58 then 0.54).

## 2026-10-02, lexical baseline (`--lexical`)

BM25 over the name, description and parameter descriptions of the 75 default
tools: a labelled tool ranks first for 9/36 development and 11/36 held-out
requests, and in the top 5 for 19/36 of each (53%).
