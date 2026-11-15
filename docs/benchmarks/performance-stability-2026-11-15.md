# Performance and Compatibility Assessment — 2026-11-15

## Scope and decision

This campaign validates two unreleased source optimizations: reuse active-job counts within monitoring passes, and replace the JavaScript MessagePack prototype-key byte scan with a native `Buffer.indexOf` over the exact input view. The retained implementation preserves the existing safe conversion path and invalidates monitoring counts after synchronous idle-event callbacks.

A grouped durable SQLite admission prototype was rejected. Production SQLite admission is unchanged. Prototype timings are excluded from every delivered-performance claim below. This report does not describe a package release or establish deployment capacity.

## Provenance and method

- Baseline Git revision: `732c1fb54378d71f467b5a2af9c9a32cc8da8475`.
- Measured candidate tree recorded by the native coordinator: `697d296bf346bfd112b569f557058fed7cda7202`. Final source verification used the actual retained implementation, not earlier prototypes. The closure review records runtime source matching gated tree `3271985cfb92e861756bc4c887d38b77b9922719`; subsequent closure changes were documentation and work-state changes.
- Native host: Apple M5 Max, 18 logical CPUs, 68,719,476,736 bytes RAM (64 GiB), Darwin 27.2.0, arm64, Bun 1.4.4. No container timings are used as performance evidence.
- Seven fresh-process measurements per variant and scenario; one discarded fresh-process warm-up per variant and scenario; serial execution with alternating AB/BA order. Ten scenarios yield 140 retained measurements and 20 discarded warm-ups.
- Source: `artifacts/perf-stability/native/verified-report.json`. Public [samples](https://bunqueue.dev/benchmarks/performance/2026-11-15/samples.json), [summaries](https://bunqueue.dev/benchmarks/performance/2026-11-15/summaries.json), [manifest](https://bunqueue.dev/benchmarks/performance/2026-11-15/manifest.json), and [SHA-256 checksums](https://bunqueue.dev/benchmarks/performance/2026-11-15/SHA256SUMS) retain the timing evidence. The public data is a documented projection removing private paths and process stdout, not a new measurement campaign; the manifest links the original harness sources provided as text.

These are engineering-grade, narrowly targeted timings. The campaign does not characterize power modes, independent hosts, production contention, sustained capacity, or production p95/p99 latency. Seven measurements give useful ranges and variation, not a population tail estimate.

## Decoder results

Timing covers repeated `decodeMessagePack` calls on an already encoded, independently owned frame. Encoding, setup, and correctness probes are outside the timed loop. Payload sizes refer to text data, not total encoded frame size. CV is the report's coefficient of variation expressed as a percentage; medians and ranges are milliseconds. Full-precision statistics remain in the linked JSON.

| Scenario | Decodes/sample | Baseline median | Baseline min–max | Baseline CV | Candidate median | Candidate min–max | Candidate CV | Duration ratio |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: |
| 32 B text | 500,000 | 117.603459 | 115.180083–118.342792 | 0.8886% | 116.552792 | 115.898750–117.895959 | 0.6263% | 1.0090× |
| 64 KiB text | 2,000 | 186.146666 | 156.466458–194.391584 | 6.4666% | 9.827125 | 9.398958–10.401833 | 2.9713% | 18.9421× |
| 1 MiB text | 200 | 183.796041 | 181.358875–186.184792 | 0.7528% | 12.922375 | 12.501667–13.455750 | 2.6645% | 14.2231× |
| Explicit own `__proto__`, 32 B text | 100,000 | 76.424625 | 74.025500–79.894250 | 2.5035% | 76.606584 | 74.766917–84.274250 | 4.7828% | 0.9976× |

The mechanism removes a JavaScript byte-by-byte scan on large frames. `Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)` creates a bounded view without copying the payload; `indexOf` performs the search. The safe conversion still handles frames containing the prototype-key bytes. Checks covered payload checksums, own and nested prototype-key values, unchanged object/global prototypes, and subarray offset/length guards. A separate decoder diagnostic preserved baseline error behavior. Small-frame and prototype-key timings do not support a meaningful improvement claim. Decoder ratios are not job-throughput ratios.

## TCP results

Each sample starts a separate fresh broker on a dynamic loopback port. Storage is **memory-only**. A `TcpClient` sends 2,000 sequential scalar `PUSH` commands, followed by 2,000 scalar `PULL`/`ACK` pairs. The timed interval begins before the first push and ends after the last ACK; startup, final conservation checks, and shutdown are outside it. The broker request cap is explicitly set to 100,000 for these 2,000-job scenarios. No client auto-batching, worker processing, or durable-storage claim is involved.

All durations below are milliseconds. A phase median need not sum to the whole-loop median because each statistic is calculated independently across samples.

| Payload / phase | Baseline median | Baseline min–max | Baseline CV | Candidate median | Candidate min–max | Candidate CV | Duration ratio |
| --- | ---: | --- | ---: | ---: | --- | ---: | ---: |
| 32 B / PUSH | 77.789208 | 77.271958–78.882500 | 0.6894% | 77.608458 | 76.967542–77.997083 | 0.3873% | 1.0023× |
| 32 B / PULL+ACK | 150.559959 | 148.795041–151.132833 | 0.4907% | 151.030500 | 149.547208–153.148750 | 0.7982% | 0.9969× |
| 32 B / whole loop | 228.451083 | 227.525250–229.617208 | 0.2974% | 228.777000 | 226.514750–230.757208 | 0.5925% | 0.9986× |
| 64 KiB / PUSH | 192.421708 | 190.453333–200.063917 | 1.6641% | 162.289291 | 159.889250–168.328666 | 1.6953% | 1.1857× |
| 64 KiB / PULL+ACK | 261.163375 | 258.329375–270.588417 | 1.4340% | 237.526584 | 230.260584–242.011834 | 1.6273% | 1.0995× |
| 64 KiB / whole loop | 455.990833 | 451.294625–461.729250 | 0.8735% | 399.550833 | 391.053250–410.340500 | 1.4666% | 1.1413× |

For the 64 KiB whole loop, median duration decreases **12.377441807037382%** and the corresponding median completion-rate ratio is **1.1412586217784209×**. The small TCP distributions overlap; its roughly 0.14% median slowdown is inconclusive. Every sample verified unique accepted/delivered IDs, FIFO sequence and payload checksum, 2,000 completions, zero waiting/active jobs, an empty final pull, and exact pushed/pulled/completed counters. Broker stderr and unexpected exit were fatal to the harness.

## Monitoring results and controls

The timed operation is an in-memory monitoring pass over prepared queue/processing state, not a public HTTP request or job lifecycle. Each queue also has three waiting and two delayed jobs: 300/200 in the 100-queue case, and 3,000/2,000 in the 1,000-queue case. The 100-queue sample repeats 256 passes; the stress sample repeats eight. The small control uses one queue with one active job and 500,000 passes; the disabled control uses 5,000,000 passes. Each sample performs eight untimed in-process warm-up passes in addition to the discarded fresh-process warm-up. Setup is untimed. Reported per-pass times are milliseconds.

| Scenario | Baseline median | Baseline min–max | Baseline CV | Candidate median | Candidate min–max | Candidate CV | Duration ratio |
| --- | ---: | --- | ---: | ---: | --- | ---: | ---: |
| 100 queues / 10,000 active | 2.2842345390625 | 2.24448079296875–2.37216845703125 | 2.1122% | 0.09053466796875 | 0.08601692578125–0.09391194921875 | 3.0988% | 25.2305× |
| 1,000 queues / 100,000 active | 502.040723875 | 482.0379375–540.29174475 | 3.8678% | 1.5601875 | 1.48439575–1.795770875 | 6.3880% | 321.7823× |
| One-queue control | 0.000168548834 | 0.0001632165–0.000174701334 | 2.0178% | 0.000192634666 | 0.00018817725–0.0001975625 | 1.6282% | 0.8750× |
| Disabled path | 0.0000183797416 | 0.000018283675–0.0000184284916 | 0.2604% | 0.0000183132916 | 0.0000181819666–0.0000187123084 | 0.8472% | 1.0036× |

The repeated active-job scan changes from one scan per queue to a lazily built per-pass map. The one-queue direct-scan path remains. After an idle-event callback the map is discarded so later decisions see synchronous changes. A callback-heavy workload can consequently rebuild the map and is not represented by the large speedup figures.

The one-queue control adds **24.085832 ns/pass**, or **14.29012080854859%**. This is an observed cost, despite its small absolute size. The disabled-path difference is inconclusive. Large timed cases emitted zero events; separate oracles verified exact threshold/idle/worker events, waiting-boundary inclusion, unchanged disabled/missing-emitter state, synchronous callback mutation visibility, lifecycle counters, and matching state/event checksums.

## Rejected SQLite experiment

Evidence: `artifacts/perf-stability/reviews/task-1-report.md`, `sqlite/fault-summary.json`, and `sqlite/crash-matrix.json`. Twenty fresh-process fault scenarios compared ten cases across baseline and prototype; eight separate SIGKILL/recovery cases examined persistence boundaries. These are diagnostic compatibility experiments, not a shipped SQLite benchmark or an equivalence pass.

The scalar path persists each input before publishing it. Grouping inserts moves that durable-prefix boundary. A second-row rejection with unavailable COMMIT/ROLLBACK operations left the baseline with one RAM/disk/recovered job, but the prototype with one RAM job, zero durable/recovered jobs, and an open transaction. Throwing payload accessors and proxies observed a different `jobIndex` prefix because preparation happened earlier. A closed-connection case also diverged and the prototype restart encountered `SQLITE_BUSY`.

After SIGKILL immediately following the first insert, the baseline recovered one row and the prototype zero. The prototype recovered zero before grouped COMMIT, but three after successful COMMIT and after public return. Baseline before/after-COMMIT controls have no explicit COMMIT hook and fall through to the after-return kill, recovering three. This distinguishes the changed intermediate boundary from normal successful post-return recovery.

BEGIN failure, confirmed rollback/replay, and native automatic-rollback controls could match the scalar result; they did not resolve the general compatibility problem. Fault wrappers throwing before native COMMIT/ROLLBACK model unavailable operations, rather than asserting that native SQLite emits those exact JavaScript exceptions. No transaction-grouping source or production recovery hook was retained, and no SQLite gain is claimed.

## Independent functional evidence

The closure receipts record the following results for the retained runtime source. These runs overlap and **must not be summed as unique tests**. Existing and environmental skips remain visible.

| Validation | Recorded result | Receipt |
| --- | --- | --- |
| `bun run test:model` | 12 pass, 0 fail; 100,418 assertions; seed `20261115` | `artifacts/perf-stability/model.log` |
| `bun run test:sandbox` | Bun 11,931 pass / 0 fail / 404 skips; TCP 553/0; Embedded 349/0 | `artifacts/test-sandbox/2026-11-15T15-42-48.005Z/summary.json` |
| `bun run test:sandbox:sdk` | 1,557 pass / 0 fail / 3 skips across six suites | `artifacts/test-sandbox-sdk/2026-11-15T15-50-29.305Z/summary.json` |
| Fresh isolated Ubuntu 24.04.5 arm64 Machine | Bun 12,062/0/404; TCP 553/0; Embedded 349/0; tinyfs 9/0; Machine deleted | `artifacts/machines/20261115T154248Z/manifest.md` |
| `bun run typecheck`, `bun run format:check`, `./init.sh` | Green; typecheck 890 source + 2,163 test files; format 2,373 files; init checks 179/0 | `artifacts/perf-stability/closure.json` |
| Documentation readers | 408 pass / 0 fail, 30 files, 1,949 expectations | `artifacts/perf-stability/closure.json` |
| Protected-file comparison | 1,558 test/fixture/runner files byte-identical; none added or removed | `artifacts/perf-stability/closure.json` |
| Independent final source review | PASS; no identified introduced correctness/stability defect | `artifacts/perf-stability/final-verdict.txt` |

These receipts document the original implementation closure. Later article/site integration checks are recorded by the publishing session, not inferred from these earlier results. Regression checks and an independent review bound the evidence; they do not prove absence of every defect or provide a blanket production stability guarantee.

## Reproduction and interpretation

The public manifest identifies the baseline, measured candidate tree, sample order, and original throwaway harnesses. Run those harnesses against the two source roots on a quiet native host, with Bun 1.4.4, using fresh processes/state and the same discarded warm-ups and alternating order. Do not use container timings as replacements or mix earlier SQLite prototype results into the candidate summaries. Compare checksum/state results before comparing durations.

Read the delivered result as three separate observations: monitoring passes avoid repeated scans at large queue counts; large-frame decoder scans become much cheaper; the measured 64 KiB scalar TCP loop takes about 12.38% less time. None establishes durable SQLite throughput, worker application throughput, production tails, or general capacity.
