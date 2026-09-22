# Corrupted / lost transaction -- FT

Run window: 2026-09-22 10:37:05.055 to 2026-09-22 10:38:15.565 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment.

**Expected behaviour of the fault-tolerance mechanisms:** The recovery sweep rolls the orphaned checkpoint back so no money is half-moved, and the idempotency key ensures the client retry does not become a second charge.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Corrupted / lost transaction |

| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12371 |
| Successful | 12134 |
| **Failed** | **237** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 98.08 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 4 ms (via client-visible failure) |
| Fault actively absorbed for | 5137 ms (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 15 / 19 / 33 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 9 |
| Requests rescued by retry | 0 |
| Circuit breaker openings | 1 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 429 |
| Orphaned checkpoints rolled back | 2 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 2687 | |
| Distinct payment intents | 2258 | |
| Completed payments in the database | 2258 | |
| **Duplicate charges** | 0 | PASS -- every intent charged exactly once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 2 | |
| Amount charged vs expected | 225800 vs 225800 | PASS |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (12371 lines)
* `events.jsonl` -- one line per service-side event in this window (49458 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
