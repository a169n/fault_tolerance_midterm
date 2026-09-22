# Baseline vs fault-tolerant: results and comparison

All twelve runs use an identical 70 s observation window, an identical workload
(10 concurrent clients; 60 % student reads, 20 % transcript reads, 20 % payments,
of which 20 % are client-side resends of the same payment intent) and an identical
fault injected at T+20 s with an operator repair at T+45 s. The two versions are
the same container image; only `FT_ENABLED` and the restart policy differ.

## 1. Headline comparison

| Scenario | Failed (baseline) | Failed (FT) | Avail. req (base) | Avail. req (FT) | Detect (base) | Detect (FT) | Dup. charges (base) | Dup. (FT) | Orphans (base) | Orphans (FT) |
|---|---|---|---|---|---|---|---|---|---|---|
| Application crash | 1313 / 12002 | **0 / 12118** | 89.06 % | **100.00 %** | 91 ms | 85 ms | 446 | **0** | 0 | **0** |
| Database failure | 37 / 6771 | **472 / 8918** | 99.45 % | **94.71 %** | 164 ms | 278 ms | 291 | **0** | 0 | **0** |
| Network / service timeout | 0 / 7920 | **0 / 8770** | 100.00 % | **100.00 %** | -- | 824 ms | 297 | **0** | 0 | **0** |
| Hardware / node failure | 2455 / 12133 | **0 / 12469** | 79.77 % | **100.00 %** | 271 ms | 253 ms | 345 | **0** | 0 | **0** |
| Corrupted / lost transaction | 2026 / 12392 | **237 / 12371** | 83.65 % | **98.08 %** | 25 ms | 4 ms | 298 | **0** | 2 | **0** |
| High load | 95 / 41367 | **0 / 44020** | 99.77 % | **100.00 %** | 49947 ms | -- | 1619 | **0** | 0 | **0** |

## 2. Campaign totals

| Measure | Baseline | Fault-tolerant | Change |
|---|---|---|---|
| Runs | 6 | 6 | |
| Total requests | 92585 | 98666 | |
| Failed requests | **5926** | **709** | 88.0 % fewer |
| Availability (request-based) | 93.60 % | 99.28 % | |
| Availability (time-based) | 99.74 % | 100.00 % | |
| Observed outages | 1 | 0 | |
| Total downtime | 10.1 s | 0.0 s | |
| MTTF | 413.0 s | > 423 s (censored) | |
| MTBF | 423.1 s | n/a | |
| MTTR | 10.1 s | n/a (nothing to repair) | |
| Observed failure rate | 8.5 /h | 0.0 /h | |
| **Duplicate charges** | **3296** | **0** | |
| **Orphaned checkpoints** | **2** | **0** | |

Each version was exposed to six injected faults over 423 s
and 423 s of observation respectively.

## 3. What happened in each scenario

**Application crash.** The baseline lost 1313 of
12002 requests (10.94 %).
The arithmetic explains itself: student traffic is 60 % of the mix, round robin
sends half of it to the dead instance, and the instance is dead for 25 of the 70
seconds -- 0.6 x 0.5 x 25/70 = 10.7 %, against 10.9 % measured. The baseline has no
health checks, so the gateway kept routing to a process that no longer existed. The
fault-tolerant version detected the crash in 85 ms from a
failed call attempt, rescued 19 in-flight requests by
retrying them onto student-2, and lost nothing. Note that time-based availability is
100 % in both versions: the service never stopped answering, it just answered wrongly
half the time -- which is precisely why request-based availability must also be reported.

**Database failure.** This is the one row where the fault-tolerant version looks
worse, and the explanation matters. It returned 472 errors against the
baseline's 37, but those errors are payment *writes* failing fast: a hot
standby is read-only, so with the primary down there is nowhere for a write to go, and
failing in 16 ms is the correct behaviour. Meanwhile reads stayed up --
144 served from the standby and
1605 from the stale cache -- and the client-visible outage was zero.
The baseline's low error count is an artefact: with no timeout, 22 requests hung for the
client's full 10 s patience, and a blocked client issues no further requests. Throughput
collapsed from 8918 to 6771 requests and the system was genuinely
unavailable for 10.1 s (time-based availability
97.83 %). Hanging is not better than failing; it only looks
better in a ratio whose denominator it destroys.

**Network / service timeout.** Neither version lost a request, so availability says
nothing. Latency says everything: baseline p99 was 3005 ms -- the full injected
delay, paid by every client unlucky enough to be routed to the slow instance -- against
845 ms with fault tolerance, where the 800 ms per-attempt timeout fired and
the retry landed on the healthy replica. 247 requests were rescued this way. This
is the scenario a liveness probe cannot catch: the slow instance kept answering
/health in milliseconds throughout.

**Hardware / node failure.** Killing student-1 and payment-1 together cost the baseline
2455 requests (20.23 %) and the fault-tolerant version
0. The surviving node absorbed the entire load; the platform degraded in
capacity, not in availability, which is the whole point of replicating across nodes.
Detection took 253 ms and 38 requests were rescued by retry.

**Corrupted / lost transaction.** The most important row for data integrity. Both
payment instances died between writing the durable checkpoint and committing the
charge. The fault-tolerant version's recovery sweep rolled back
2 orphaned checkpoints, leaving 0 rows stuck in `pending` and
0 duplicate charges. The baseline left 2 payments permanently
in `pending` -- money neither charged nor released, with no process that will ever
reconcile them -- and charged 298 students twice.

**High load.** Raising concurrency from 10 to 110 workers broke neither version's
availability, and throughput was comparable (41367 vs 44020 requests).
The difference is that the baseline began failing 50 s into the overload and lost
95 requests, while the fault-tolerant version lost none at a p95 of
136 ms. Duplicate charges tell the sharper story: 1619 in the baseline,
because overload is exactly when clients retry and exactly when a system without
idempotency keys charges them twice.

## 4. Which mechanism did the work

Counts are from the fault-tolerant runs; the baseline has none of these paths.

| Scenario | Failed calls absorbed | Rescued by retry | Breaker openings | Degraded responses | Replica reads | Duplicates suppressed | Checkpoints rolled back |
|---|---|---|---|---|---|---|---|
| Application crash | 19 | 19 | 0 | 0 | 0 | 484 | 0 |
| Database failure | 223 | 8 | 3 | 1749 | 144 | 247 | 0 |
| Network / service timeout | 247 | 247 | 0 | 0 | 0 | 336 | 0 |
| Hardware / node failure | 38 | 38 | 0 | 0 | 0 | 443 | 0 |
| Corrupted / lost transaction | 9 | 0 | 1 | 0 | 0 | 429 | 2 |
| High load | 0 | 0 | 0 | 0 | 0 | 1779 | 0 |

Campaign totals: 536 failed upstream calls absorbed internally,
312 requests rescued by retry, 4 circuit-breaker openings,
1605 responses served degraded, 144 reads failed over to the
standby.

## 5. Theoretical vs measured availability

A series-parallel model of the platform: gateway (single) -> student (2 replicas)
-> payment (2 replicas) -> transcript (single) -> database (single writable primary).

Assumption: each component has an MTTF of 720 h (one failure per
component per month). MTTR is the campaign-measured value for each version
(10.1 s baseline,
no outage measured, 3 s assumed fault-tolerant).

| | Baseline | Fault-tolerant |
|---|---|---|
| Component availability | 99.999612 % | 99.999884 % |
| Predicted system availability | 99.998061 % | 99.999769 % |
| Measured (time-based, under injected faults) | 99.74 % | 100.00 % |

The predicted figures are far higher than the measured ones, and the discrepancy
is expected rather than an error: the model assumes faults arrive at the natural
component failure rate, whereas the campaign injects one fault every 70 s --
roughly 37029x the assumed rate. The model
also assumes independent failures, which the node-failure scenario deliberately
violates by taking out two components at once. The useful reading is the *ratio*
between the two columns, not the absolute values: replication raises predicted
availability by turning single points of failure into parallel pairs, and the
measured results reproduce that ordering.

## 6. Threats to validity

* **Three baseline runs were repeated.** In the first pass, node-failure,
  txn-interrupt and high-load stretched their 70 s window to 357 s, 150 s and
  262 s: with no timeout anywhere in the baseline, a single request hung on a
  stale keep-alive connection and the workload generator waited for it. The
  generator now closes the window unconditionally and marks anything still in
  flight as abandoned. Only the repeated runs are reported. The window length of
  every run is published in `EXPERIMENT-LOG.md` so this class of distortion is
  visible rather than hidden.
* **Request-based availability flatters the baseline.** A blocked client issues no
  further requests, so hangs shrink the denominator instead of showing up as
  failures. This is why time-based availability and absolute throughput are
  reported alongside it.
* **One container models one node.** Real node failure would also take out the
  host kernel, local disk and network path; this campaign only removes processes.
* **Single replication factor.** Two replicas per service and one standby is the
  smallest configuration that demonstrates the mechanisms; it says nothing about
  how the system behaves at larger scale.
* **The operator repair is simulated** as a fixed 25 s delay after injection. Real
  mean time to repair depends on paging, diagnosis and human response, all of
  which are outside this measurement.
