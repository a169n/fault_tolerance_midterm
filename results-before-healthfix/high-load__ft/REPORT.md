# High load -- FT

Run window: 2026-09-22 10:38:16.870 to 2026-09-22 10:39:27.393 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

Concurrency is raised from 10 to 110 workers for the remainder of the run. No component is broken -- the system is simply asked for more than it was sized for.

**Expected behaviour of the fault-tolerance mechanisms:** Latency rises but the service keeps answering; timeouts and the circuit breaker shed load instead of letting queues grow without bound.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | High load |

| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 44020 |
| Successful | 44020 |
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
| **Detection time** | n/a |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 87 / 136 / 163 / 501 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 0 |
| Requests rescued by retry | 0 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 1779 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 10303 | |
| Distinct payment intents | 8524 | |
| Completed payments in the database | 8524 | |
| **Duplicate charges** | 0 | PASS -- every intent charged exactly once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 852400 vs 852400 | PASS |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (44020 lines)
* `events.jsonl` -- one line per service-side event in this window (177859 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
