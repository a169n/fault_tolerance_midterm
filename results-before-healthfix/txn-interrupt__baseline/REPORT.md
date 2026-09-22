# Corrupted / lost transaction -- BASELINE

Run window: 2026-09-22 13:19:04.223 to 2026-09-22 13:20:14.731 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment.

**Expected behaviour of the fault-tolerance mechanisms:** The recovery sweep rolls the orphaned checkpoint back so no money is half-moved, and the idempotency key ensures the client retry does not become a second charge.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Corrupted / lost transaction |

| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12392 |
| Successful | 10366 |
| **Failed** | **2026** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 1 |
| Availability, request-based | 83.65 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 25 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 13 / 17 / 36 ms |

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
| Payment requests accepted | 1867 | |
| Distinct payment intents | 1570 | |
| Completed payments in the database | 1868 | |
| **Duplicate charges** | 298 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 2 | FAIL -- transactions stuck in pending forever |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 186800 vs 157000 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12392 lines)
* `events.jsonl` -- one line per service-side event in this window (35148 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
