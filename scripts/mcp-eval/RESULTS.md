# Toolset routing results

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
