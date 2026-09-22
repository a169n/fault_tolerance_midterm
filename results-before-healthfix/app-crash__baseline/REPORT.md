# Application crash -- BASELINE

Run window: 2026-09-22 10:39:54.786 to 2026-09-22 10:41:05.297 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

student-1 kills its own process (exit 1) from inside the container, simulating an unhandled fatal error rather than an operator stop.

**Expected behaviour of the fault-tolerance mechanisms:** Health checks detect the dead instance within one poll interval, the gateway routes to student-2, the restart policy brings the instance back, and in-flight requests are saved by retry.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Application crash |

| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12002 |
| Successful | 10689 |
| **Failed** | **1313** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 89.06 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 91 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 9 / 16 / 20 / 1044 ms |

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
| Payment requests accepted | 2731 | |
| Distinct payment intents | 2285 | |
| Completed payments in the database | 2731 | |
| **Duplicate charges** | 446 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 273100 vs 228500 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12002 lines)
* `events.jsonl` -- one line per service-side event in this window (33382 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
