# Hardware / node failure -- BASELINE

Run window: 2026-09-22 13:17:49.620 to 2026-09-22 13:19:00.127 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. A SIGKILL from the operator does not trip the restart policy, so the node stays down until it is repaired.

**Expected behaviour of the fault-tolerance mechanisms:** The surviving node (student-2, payment-2) absorbs the full load; the platform degrades in capacity, not in availability.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Hardware / node failure |

| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12133 |
| Successful | 9678 |
| **Failed** | **2455** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 2 |
| Availability, request-based | 79.77 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 271 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 14 / 22 / 1014 ms |

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
| Payment requests accepted | 2336 | |
| Distinct payment intents | 1991 | |
| Completed payments in the database | 2336 | |
| **Duplicate charges** | 345 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 233600 vs 199100 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12133 lines)
* `events.jsonl` -- one line per service-side event in this window (32913 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
