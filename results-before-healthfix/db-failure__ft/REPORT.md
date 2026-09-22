# Database failure -- FT

Run window: 2026-09-22 10:33:29.547 to 2026-09-22 10:34:40.055 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

The PostgreSQL primary is stopped. The hot standby stays up.

**Expected behaviour of the fault-tolerance mechanisms:** Reads fail over to the standby, the transcript service serves stale cached data flagged as degraded, writes fail fast instead of hanging, and the circuit breaker prevents a retry storm.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Database failure |
| T+20.3s | health probe | student-2:3000 -> UNHEALTHY |
| T+20.3s | health probe | payment-1:3000 -> UNHEALTHY |
| T+20.3s | health probe | payment-2:3000 -> UNHEALTHY |
| T+20.3s | health probe | student-1:3000 -> UNHEALTHY |
| T+21.8s | health probe | transcript-1:3000 -> UNHEALTHY |
| T+48.6s | health probe | payment-2:3000 -> healthy |
| T+48.6s | health probe | student-2:3000 -> healthy |
| T+48.8s | health probe | payment-1:3000 -> healthy |
| T+50.1s | health probe | transcript-1:3000 -> healthy |
| T+51.6s | health probe | student-1:3000 -> healthy |
| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 8918 |
| Successful | 8446 |
| **Failed** | **472** |
| Served degraded (HTTP 203, stale data) | 1605 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 94.71 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 278 ms (via client-visible failure) |
| Fault actively absorbed for | 31298 ms (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 8 / 16 / 26 / 2561 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 223 |
| Requests rescued by retry | 8 |
| Circuit breaker openings | 3 |
| Degraded (stale-data) responses | 1749 |
| Reads failed over to the standby | 144 |
| Duplicate payments suppressed | 247 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests accepted | 1532 | |
| Distinct payment intents | 1285 | |
| Completed payments in the database | 1285 | |
| **Duplicate charges** | 0 | PASS -- every intent charged exactly once |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back | 0 | |
| Amount charged vs expected | 128500 vs 128500 | PASS |
| Ledger balanced (payments = balances) | true | PASS |

## Raw data

* `workload.jsonl` -- one line per client request (8918 lines)
* `events.jsonl` -- one line per service-side event in this window (33990 lines)
* `metrics.json` -- the computed metrics above, machine-readable

Metric definitions are in `scripts/metrics.ts`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
