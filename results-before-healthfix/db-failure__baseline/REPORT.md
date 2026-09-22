# Database failure -- BASELINE

Run window: 2026-09-22 10:41:06.665 to 2026-09-22 10:42:17.175 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

The PostgreSQL primary is stopped. The hot standby stays up.

**Expected behaviour of the fault-tolerance mechanisms:** Reads fail over to the standby, the transcript service serves stale cached data flagged as degraded, writes fail fast instead of hanging, and the circuit breaker prevents a retry storm.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Database failure |

| T+30.3s | first failed request | outage begins |
| T+40.4s | first success after outage | outage ends (10.1 s) |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 6771 |
| Successful | 6734 |
| **Failed** | **37** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 22 |
| Availability, request-based | 99.45 % |
| Availability, time-based | 97.83 % |
| Observed failures (outages) | 1 |
| MTTF | 30.3 s |
| MTBF | 40.4 s (MTTF + MTTR (fewer than two outages)) |
| MTTR | 10.1 s |
| Observed failure rate | 51.1 outages/hour |
| **Detection time** | 164 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | 20380 ms |
| Latency p50 / p95 / p99 / max | 9 / 16 / 19 / 9563 ms |

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
| Payment requests accepted | 1674 | |
| Distinct payment intents | 1384 | |
| Completed payments in the database | 1675 | |
| **Duplicate charges** | 291 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 167500 vs 138400 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (6771 lines)
* `events.jsonl` -- one line per service-side event in this window (20298 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
