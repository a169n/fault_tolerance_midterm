# High load -- BASELINE

Run window: 2026-09-22 13:20:18.820 to 2026-09-22 13:21:29.341 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

Concurrency is raised from 10 to 110 workers for the remainder of the run. No component is broken -- the system is simply asked for more than it was sized for.

**Expected behaviour of the fault-tolerance mechanisms:** Latency rises but the service keeps answering; timeouts and the circuit breaker shed load instead of letting queues grow without bound.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | High load |

| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 41367 |
| Successful | 41272 |
| **Failed** | **95** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 99.77 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 49947 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 85 / 134 / 298 / 1214 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 0 |
| Requests rescued by retry | 0 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 0 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 9603 | |
| Distinct payment intents | 8001 | |
| Completed payments in the database | 9620 | |
| **Duplicate charges** | 1619 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 962000 vs 800100 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (41367 lines)
* `events.jsonl` -- one line per service-side event in this window (124101 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
