# Application crash -- FT

Run window: 2026-09-21 15:39:24.594 to 2026-09-21 15:40:35.102 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

student-1 kills its own process (exit 1) from inside the container, simulating an unhandled fatal error rather than an operator stop.

**Expected behaviour of the fault-tolerance mechanisms:** Health checks detect the dead instance within one poll interval, the gateway routes to student-2, the restart policy brings the instance back, and in-flight requests are saved by retry.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Application crash |

| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12254 |
| Successful | 12254 |
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
| **Detection time** | 64 ms (via failed call attempt) |
| Fault actively absorbed for | 1036 ms (last internal failure after injection) |
| Fault masked from clients entirely | yes -- detected and absorbed before any client saw a failure |
| **Recovery time** (client-visible outage ends) | no client-visible outage occurred |
| Latency p50 / p95 / p99 / max | 7 / 15 / 25 / 849 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 15 |
| Requests rescued by retry | 15 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 445 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 2799 | |
| Distinct payment intents | 2354 | |
| Completed payments in the database | 2354 | |
| **Duplicate charges** | 0 | PASS -- every intent charged exactly once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 235400 vs 235400 | PASS |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12254 lines)
* `events.jsonl` -- one line per service-side event in this window (49493 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
