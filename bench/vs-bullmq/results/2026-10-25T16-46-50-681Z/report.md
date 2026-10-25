# bunqueue vs BullMQ + Redis

Run 2026-10-25T16:46:50.682Z: AMD Ryzen 9 7950X3D 16-Core Processor (32 logical CPUs), Debian GNU/Linux 13 (trixie), Linux 6.12.48+deb13-amd64, governor performance; Bun 1.4.4, Node.js v24.22.1, Docker version 29.9.2, build a82e528, redis:8.10.2; bunqueue 2.9.20, BullMQ 6.4.2, ioredis 6.0.0. Broker on CPUs 2,3,18,19, clients on 8-15,24-31. Each cell: median of 5 measured runs after one warm-up, with the min–max range.

## In memory

| Scenario | bunqueue | bunqueue, long polling | BullMQ on Node.js | BullMQ on Bun | bunqueue vs best BullMQ |
| --- | --- | --- | --- | --- | --- |
| Add, one at a time (jobs/s) | 28,890 <small>(27,036–29,538)</small> | – | 19,450 <small>(18,927–19,534)</small> | 22,730 <small>(22,366–23,231)</small> | **1.27x** |
| Add, 64 in flight (jobs/s) | 202,072 <small>(198,734–219,865)</small> | – | 68,094 <small>(67,780–70,096)</small> | 77,692 <small>(75,974–79,439)</small> | **2.60x** |
| addBulk, 100 per call (jobs/s) | 207,601 <small>(186,591–217,414)</small> | – | 47,831 <small>(47,232–48,015)</small> | 52,503 <small>(51,567–53,303)</small> | **3.95x** |
| Drain, 1 worker process x 50 (jobs/s) | 43,335 <small>(43,240–45,233)</small> | 43,309 <small>(43,226–45,240)</small> | 38,402 <small>(38,314–38,429)</small> | 38,262 <small>(38,171–38,306)</small> | **1.13x** |
| Drain, 4 worker processes x 50 (jobs/s) | 53,754 <small>(52,417–53,920)</small> | 52,428 <small>(51,080–53,924)</small> | 40,699 <small>(40,653–40,714)</small> | 39,879 <small>(39,837–40,653)</small> | **1.32x** |
| Drain, 8 worker processes x 50 (jobs/s) | 42,408 <small>(41,534–42,429)</small> | 41,566 <small>(41,528–43,234)</small> | 39,873 <small>(39,856–39,874)</small> | 39,830 <small>(39,814–39,857)</small> | **1.06x** |
| Pickup latency p50 at 1,000 jobs/s (ms) | 25.6 <small>(25.5–25.6)</small> | 0.65 <small>(0.64–0.65)</small> | 0.78 <small>(0.78–0.78)</small> | 0.70 <small>(0.70–0.71)</small> | **1.09x** |
| Pickup latency p99 at 1,000 jobs/s (ms) | 50.1 <small>(50.1–50.2)</small> | 1.18 <small>(1.18–1.19)</small> | 1.35 <small>(1.35–1.36)</small> | 1.25 <small>(1.25–1.25)</small> | **1.06x** |
| Pickup latency p50 at 5,000 jobs/s (ms) | 25.5 <small>(25.4–25.6)</small> | 0.81 <small>(0.80–0.82)</small> | 1.02 <small>(1.01–1.03)</small> | 0.88 <small>(0.88–0.88)</small> | **1.08x** |
| Pickup latency p99 at 5,000 jobs/s (ms) | 50.1 <small>(50.1–50.2)</small> | 2.68 <small>(2.50–2.96)</small> | 1.56 <small>(1.55–1.57)</small> | 1.37 <small>(1.36–1.38)</small> | **0.51x** |
| Pickup latency p50 at 10,000 jobs/s (ms) | 25.5 <small>(25.5–25.6)</small> | 0.94 <small>(0.93–0.94)</small> | 1.41 <small>(1.40–1.41)</small> | 1.14 <small>(1.14–1.14)</small> | **1.22x** |
| Pickup latency p99 at 10,000 jobs/s (ms) | 50.3 <small>(50.1–50.4)</small> | 4.29 <small>(4.10–5.11)</small> | 2.22 <small>(2.21–2.24)</small> | 1.84 <small>(1.80–1.87)</small> | **0.43x** |
| Delayed job lateness p50 (ms) | 5.26 <small>(5.20–5.76)</small> | 4.74 <small>(4.54–4.86)</small> | 40.5 <small>(40.2–40.6)</small> | 41.0 <small>(40.9–41.5)</small> | **8.54x** |
| Delayed job lateness p99 (ms) | 48.3 <small>(47.2–48.5)</small> | 13.1 <small>(12.9–13.7)</small> | 83.1 <small>(82.9–83.4)</small> | 83.7 <small>(83.3–84.0)</small> | **6.34x** |
| Retries (3 attempts per job) (jobs/s) | 7,119 <small>(7,118–7,129)</small> | 7,118 <small>(6,642–7,130)</small> | 4,243 <small>(4,192–4,284)</small> | 5,536 <small>(5,392–5,544)</small> | **1.29x** |

Broker resident memory with a 1,000,000-job backlog: bunqueue 2252 MiB (idle 46 MiB), Redis 618 MiB (idle 24 MiB).

## Durable (bunqueue SQLite WAL vs Redis AOF everysec)

| Scenario | bunqueue | bunqueue, long polling | BullMQ on Node.js | BullMQ on Bun | bunqueue vs best BullMQ |
| --- | --- | --- | --- | --- | --- |
| Add, one at a time (jobs/s) | 9,000 <small>(8,924–9,016)</small> | – | 17,785 <small>(17,661–18,065)</small> | 20,316 <small>(19,738–20,920)</small> | **0.44x** |
| Add, 64 in flight (jobs/s) | 31,773 <small>(31,044–33,009)</small> | – | 62,238 <small>(61,957–62,672)</small> | 63,431 <small>(63,234–63,880)</small> | **0.50x** |
| addBulk, 100 per call (jobs/s) | 41,913 <small>(41,137–42,482)</small> | – | 40,762 <small>(40,464–40,966)</small> | 44,285 <small>(43,834–45,235)</small> | **0.95x** |
| Drain, 1 worker process x 50 (jobs/s) | 4,946 <small>(4,874–5,150)</small> | 4,873 <small>(4,825–4,898)</small> | 32,201 <small>(32,180–32,226)</small> | 31,114 <small>(31,070–32,136)</small> | **0.15x** |
| Drain, 4 worker processes x 50 (jobs/s) | 4,491 <small>(4,451–4,521)</small> | 4,481 <small>(4,451–4,501)</small> | 33,242 <small>(33,225–33,260)</small> | 33,219 <small>(33,216–33,259)</small> | **0.14x** |
| Drain, 8 worker processes x 50 (jobs/s) | 4,257 <small>(4,234–4,288)</small> | 4,288 <small>(4,270–4,313)</small> | 33,233 <small>(32,716–33,240)</small> | 33,215 <small>(33,196–33,240)</small> | **0.13x** |
| Pickup latency p50 at 1,000 jobs/s (ms) | 19.4 <small>(19.3–19.6)</small> | 0.97 <small>(0.97–0.98)</small> | 0.80 <small>(0.78–0.80)</small> | 0.72 <small>(0.71–0.72)</small> | **0.74x** |
| Pickup latency p99 at 1,000 jobs/s (ms) | 47.4 <small>(47.0–47.6)</small> | 5.72 <small>(5.67–5.78)</small> | 1.38 <small>(1.34–1.38)</small> | 1.27 <small>(1.27–1.28)</small> | **0.22x** |
| Pickup latency p50 at 5,000 jobs/s (ms) | 1,504 <small>(1,476–1,641)</small> | 1,612 <small>(1,579–1,618)</small> | 1.11 <small>(1.09–1.11)</small> | 0.92 <small>(0.92–0.92)</small> | **0.00x** |
| Pickup latency p99 at 5,000 jobs/s (ms) | 3,495 <small>(3,346–3,670)</small> | 3,590 <small>(3,548–3,669)</small> | 1.65 <small>(1.65–1.68)</small> | 1.46 <small>(1.44–1.46)</small> | **0.00x** |
| Pickup latency p50 at 10,000 jobs/s (ms) | 13,186 <small>(13,042–13,188)</small> | 13,117 <small>(13,021–13,183)</small> | 1.56 <small>(1.55–1.58)</small> | 1.24 <small>(1.23–1.24)</small> | **0.00x** |
| Pickup latency p99 at 10,000 jobs/s (ms) | 22,990 <small>(22,687–23,014)</small> | 22,910 <small>(22,784–22,959)</small> | 2.77 <small>(2.74–2.96)</small> | 2.70 <small>(2.62–2.96)</small> | **0.00x** |
| Delayed job lateness p50 (ms) | 621 <small>(615–645)</small> | 644 <small>(623–666)</small> | 39.2 <small>(39.0–39.5)</small> | 39.5 <small>(39.3–39.5)</small> | **0.06x** |
| Delayed job lateness p99 (ms) | 1,166 <small>(1,127–1,189)</small> | 1,181 <small>(1,151–1,221)</small> | 82.0 <small>(81.7–82.7)</small> | 81.6 <small>(81.0–81.9)</small> | **0.07x** |
| Retries (3 attempts per job) (jobs/s) | 809 <small>(806–819)</small> | 809 <small>(806–812)</small> | 4,074 <small>(4,047–4,141)</small> | 4,985 <small>(4,978–4,989)</small> | **0.16x** |

Broker resident memory with a 1,000,000-job backlog: bunqueue 2415 MiB (idle 49 MiB), Redis 583 MiB (idle 24 MiB).

Ratios compare the better bunqueue configuration with the better BullMQ runtime; above 1x bunqueue is ahead (higher throughput or lower latency). For latency rows the ratio is BullMQ latency / bunqueue latency.
