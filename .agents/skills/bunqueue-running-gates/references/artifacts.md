# Reading the sandbox artifacts

Authoritative description: [docs/testing.md](../../../../docs/testing.md#telemetry-and-engineering-kpis).
This page is the order to read them in and what each field tells you.

## Contents

- [Layout](#layout)
- [summary.md, top to bottom](#summarymd-top-to-bottom)
- [Anomalies and what to do](#anomalies-and-what-to-do)
- [Machine-readable values](#machine-readable-values)
- [Failed runs and retained containers](#failed-runs-and-retained-containers)
- [The SDK sandbox](#the-sdk-sandbox)

## Layout

```text
artifacts/test-sandbox/<timestamp>/          # the timestamp is the run id (UTC, ':' as '-')
├── unit.log | tcp.log | embedded.log        # complete, untruncated suite output
├── <suite>.metrics.ndjson                   # one docker-stats sample about every 2 s
├── <suite>.summary.json                     # per-suite totals, resources, anomalies, cases
├── summary.json                             # the run: mode, duration, passed, baseline, suites
└── summary.md                               # the human report
```

`artifacts/` is ignored by Git and by `bun test` (`bunfig.toml`), so these files never
reach a commit and their stale copies never run as tests.

## summary.md, top to bottom

1. **Overall** and **Mode**: `PASS`/`FAIL`, `parallel` (default) or `sequential`
   (`BUNQUEUE_TEST_SEQUENTIAL=1`). A sequential run is diagnostic for contention; the
   parallel run is the gate.
2. **Baseline**: the previous report the duration and memory deltas compare against. A
   failed or empty previous run is never used as a baseline.
3. **Suite KPIs**: status, duration, `Pass / Fail / Skip`, peak RAM (and percent of the
   container limit, 4 GiB by default), RAM delta, CPU average / p95 / peak, peak PIDs,
   and the **Anomalies** column. Copy the totals into the evidence exactly.
4. **Resource detail**: samples, tests per second, the memory profile and slope, block
   and network I/O. Network I/O is 0 B: the containers have no network.
5. **Slowest unit tests** and **Integration files**: compare with the previous run when
   a duration anomaly appears; a new entry near the top is usually a new fixed sleep or
   a test waiting for a deadline it never meets.

## Anomalies and what to do

| Anomaly | Meaning | Next step |
| --- | --- | --- |
| `non-zero exit code: N` | the suite failed | read the suite log; classify (SKILL.md) |
| `container was OOM-killed` | the 4 GiB limit was hit | find the test with `*.metrics.ndjson` timestamps; never just raise `BUNQUEUE_TEST_MEMORY` |
| `peak memory reached at least 80%` | close to the limit | investigate before it becomes an OOM |
| `PID usage reached at least 80%` | process leak or fork storm | look for unreaped children (servers, workers) |
| `memory growth signal: ...` | end minus start above 128 MiB and 50% | a signal, not a leak: confirm with a focused repeated-process, post-GC run |
| `duration regression vs baseline: +N%` | at least 25 % and 30 s slower | compare the slowest-test tables; check host load (another sandbox or a Machine gate running) |
| `peak-memory regression vs baseline: +N%` | at least 25 % and 64 MiB more | compare the memory profile with the baseline run |
| `no resource samples captured` | the sampler saw nothing | the run is not evidence of resource behavior; rerun |

Report an anomaly in the evidence even when the suites passed; "PASS, anomalies none"
is a stronger statement than "PASS".

## Machine-readable values

The JSON files are authoritative when `summary.md` rounds. With `jq` on the host:

```bash
run=artifacts/test-sandbox/<timestamp>
jq -r '.suites[] | "\(.suite) exit=\(.exitCode) \(.tests.passed)/\(.tests.failed)/\(.tests.skipped) \(.anomalies | join("; "))"' "$run/summary.json"
jq -r '.tests.cases[] | select(.status == "fail") | "\(.file): \(.name)"' "$run/unit.summary.json"
```

## Failed runs and retained containers

On failure the runner prints the log path and keeps the failed container. Inspect it
with `docker logs <container>`, then remove it with `docker rm <container>` once the
cause is known. Do not delete the artifact directory of a failed run before the cause
is recorded.

## The SDK sandbox

`bun run test:sandbox:sdk` writes the same schema under `artifacts/test-sandbox-sdk/`,
plus `*.build.log` per toolchain image and quiescent checkpoints for each SDK suite:
retained memory there is `anon + shmem` before and after the suite command, and a
process that outlives its suite command is reported by name. A failed run keeps its
PostgreSQL service, network and containers for diagnosis.
