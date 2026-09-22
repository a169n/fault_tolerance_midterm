# Hardware / node failure -- FT

Run window: 2026-09-22 10:35:53.180 to 2026-09-22 10:37:03.690 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. A SIGKILL from the operator does not trip the restart policy, so the node stays down until it is repaired.

**Expected behaviour of the fault-tolerance mechanisms:** The surviving node (student-2, payment-2) absorbs the full load; the platform degrades in capacity, not in availability.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Hardware / node failure |
| T+20.8s | health probe | payment-1:3000 -> UNHEALTHY |
| T+20.8s | health probe | student-1:3000 -> UNHEALTHY |
| T+46.1s | health probe | payment-1:3000 -> healthy |
| T+46.1s | health probe | student-1:3000 -> healthy |
| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12469 |
| Successful | 12469 |
| **Failed** | **0** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 100.00 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 253 ms (via failed call attempt) |
| Fault actively absorbed for | 1162 ms (last internal failure after injection) |
| Fault masked from clients entirely | yes -- detected and absorbed before any client saw a failure |
| **Recovery time** (client-visible outage ends) | no client-visible outage occurred |
| Latency p50 / p95 / p99 / max | 7 / 15 / 19 / 812 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 38 |
| Requests rescued by retry | 38 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 443 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 2821 | |
| Distinct payment intents | 2378 | |
| Completed payments in the database | 2378 | |
| **Duplicate charges** | 0 | PASS -- every intent charged exactly once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 237800 vs 237800 | PASS |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12469 lines)
* `events.jsonl` -- one line per service-side event in this window (50399 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
