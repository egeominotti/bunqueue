---
name: bunqueue
description: Use when building or operating bunqueue queues, workers, durable workflows, agent turns, MCP tools, retries, cron or dependency flows.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# bunqueue

Bun runs the embedded queue, broker, workflow engine and optional agent journal.
Install with `bun add bunqueue`; MCP additionally needs
`bun add @modelcontextprotocol/sdk`.

Choose the relevant reference:

| Task | Read |
| --- | --- |
| Queue/Worker/Bunqueue setup, cron, DLQ, batching, migration | [queue-patterns.md](queue-patterns.md), then [reference.md](reference.md) for signatures |
| Email, ETL, distributed queue examples | [examples.md](examples.md) |
| Durable multi-step work, approval, recovery, rollback | [workflow.md](workflow.md) |
| Claude/OpenAI agent turns, session resume, external effects, progress replay | [agents.md](agents.md) plus [workflow.md](workflow.md) |
| Connect/operate MCP, diagnose, page or observe jobs | [mcp.md](mcp.md) |

Use `Bunqueue` for one-process work, `Queue` + `Worker` for independent producers
and consumers, `FlowProducer` for job dependencies, and `Workflow` + `Engine`
for durable orchestration. Persist explicit database paths for restart survival.

Observe durable final state before claiming completion. Retrying a queue job or
resuming a provider session does not establish whether a remote business effect
ran; follow the agent reference's stable effect identity and reconciliation rules.
