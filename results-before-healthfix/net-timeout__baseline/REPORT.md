# Network / service timeout -- BASELINE

Run window: 2026-09-22 10:42:18.435 to 2026-09-22 10:43:28.944 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

3000 ms of artificial latency is injected into student-1 only. Its health endpoint stays fast, so the instance is alive-but-slow -- the case a liveness probe cannot catch.

**Expected behaviour of the fault-tolerance mechanisms:** The per-attempt timeout (800 ms) fires, the retry lands on student-2 via ring rotation, and the client sees a normal response time instead of a 3 s stall.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Network / service timeout |

| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 7920 |
| Successful | 7920 |
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
| Latency p50 / p95 / p99 / max | 8 / 17 / 3005 / 3031 ms |

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
| Payment requests accepted | 1814 | |
| Distinct payment intents | 1517 | |
| Completed payments in the database | 1814 | |
| **Duplicate charges** | 297 | FAIL -- the same intent was charged more than once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 181400 vs 151700 | MISMATCH |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (7920 lines)
* `events.jsonl` -- one line per service-side event in this window (23764 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
