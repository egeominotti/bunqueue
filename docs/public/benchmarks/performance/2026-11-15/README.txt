Performance and compatibility engineering campaign — 2026-11-15

The public JSON preserves captured numeric metrics/checks at full precision.
Only source-root paths, redundant stdout/stderr, and private coordinator paths
are omitted; variant names are normalized to baseline/candidate. This is a
projection of recorded samples, not a new run or reconstruction from tables.
SHA256SUMS covers the data, manifest, runtime patch and reproduction harnesses.

Runtime provenance:
baseline 732c1fb54378d71f467b5a2af9c9a32cc8da8475.
The candidate was uncommitted when measured. Apply optimized-runtime.patch.txt
to that baseline and verify the two Git blob hashes in manifest.json.
The patch changes only monitoringChecks.ts and msgpack.ts. SQLite admission
remains unchanged; this bundle contains no SQLite batching performance claim.

Reproduction (native macOS, Bun 1.4.4; engineering evidence):

1. Clone the repository and create two disposable source worktrees at the
   baseline revision. Do not use a development broker or database.
2. In the candidate worktree apply the supplied patch with:

   git apply --unidiff-zero /absolute/path/to/optimized-runtime.patch.txt

   The patch omits context so it can be published without trailing whitespace.
3. In each worktree run bun install --frozen-lockfile --ignore-scripts.
4. Download the five harness/*.ts.txt files into one directory and remove the
   .txt suffix. Keep monitoring-oracle.ts alongside monitoring-sample.ts.
   These are the original sample bodies; only the coordinator's source-root
   configuration is parameterized through environment variables.
5. Set BUNQUEUE_BASELINE_ROOT and BUNQUEUE_CANDIDATE_ROOT to absolute paths.
   Set AB_SAMPLES=7. Run the coordinator from the candidate Git worktree so
   its git-revision metadata command has a repository context.
6. With bq_perf_harness_dir set to the absolute harness directory, run:

   bun "$bq_perf_harness_dir/run-campaign.ts" msgpack \
     "$bq_perf_harness_dir/perf-decode-sample.ts" small,64k,1m,proto

   AB_LABEL=msgpack-tcp bun "$bq_perf_harness_dir/run-campaign.ts" msgpack \
     "$bq_perf_harness_dir/perf-tcp-loop-sample.ts" tcpsmall,tcp64k

   bun "$bq_perf_harness_dir/run-campaign.ts" monitoring \
     "$bq_perf_harness_dir/monitoring-sample.ts" \
     modest100queues10kactive,stress1000queues100kactive,small-control,disabled-path

Each scenario discards one process per variant and measures seven processes per
variant, alternating AB/BA order. Monitoring also primes eight passes in-process.
Sample loops, integrity checks and aggregation are unchanged by path adaptation.
The TCP sample uses a fresh separate in-memory broker and dynamic loopback port,
2000 scalar PUSH commands followed by PULL/ACK pairs; it is not a Worker or
SQLite durability benchmark. Broker exits/stderr, job conservation, counts and
checksums are validated before output. All owned state is cleaned up.

Wait for functional containers and other benchmark jobs to stop. Record the
actual host and power state for any new campaign; the historical campaign did
not record power/governor mode and provides no production p95/p99 or capacity
estimate. Do not publish VM/container timing as comparable native performance.

Interpretation:
monitoring ratios apply only to the measured event-free pass, not job throughput.
Callback behavior is checked separately; event-heavy passes can rebuild counts.
The 64KiB decoder ratio is not the end-to-end TCP ratio. Single-queue control
overhead and inconclusive small-payload results are retained in summaries.json.
