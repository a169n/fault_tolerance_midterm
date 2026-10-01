# Fault-Tolerant University Information System

Baseline and fault-tolerant versions of the same distributed university platform,
built so the two can be compared under identical injected failures.

Stack: **Python + FastAPI** services, PostgreSQL with streaming replication,
Docker Compose. Measurement harness in TypeScript (Node), which talks to the
platform only over HTTP and the shared event log, so it is independent of the
service implementation.

## Running

    npm test                # self-checks: FT core, timetable, metrics (stdlib unittest)
    npm run up:baseline     # FT_ENABLED=0, RESTART_POLICY=no
    npm run up:ft           # FT_ENABLED=1, RESTART_POLICY=unless-stopped
    npm run mode            # which version is currently deployed
    npm run exp <scenario>  # one controlled experiment
    npm run campaign        # all six scenarios against the deployed version
    npm run demo            # live failure-and-recovery demonstration (4 scenarios)
    npm run monitoring      # Prometheus on http://localhost:9090

After pulling the timetable service, recreate the database once so the new
tables and page checksums are created: `docker compose down -v`. On Windows,
where `python3` is not on the path, run the tests with
`python -m unittest discover -s tests -t .`.

The full technical report is **`REPORT.md`**; the architecture diagram is in
`docs/ARCHITECTURE.md`.

Both versions are the **same image**; only `FT_ENABLED` and `RESTART_POLICY`
differ, so every measured difference is attributable to the fault-tolerance
mechanisms. The chosen mode is written to `.env` (which Compose reads), and every
log line carries `"ft": 0|1`, so a run can never be silently misattributed.

## Services

| Component | Port | Role |
|---|---|---|
| gateway | 8080 | API gateway, load balancer, retry/timeout/circuit breaker/degradation |
| student-1 / student-2 | 3011 / 3012 | Student service, replicated |
| payment-1 / payment-2 | 3021 / 3022 | Payment service, replicated, idempotent |
| transcript-1 | 3031 | Transcript service, degrades to cache |
| timetable-1 / timetable-2 | 3041 / 3042 | Timetable generation jobs, checkpointed, adopted by a live replica after a crash |
| prometheus | 9090 | Optional monitoring (`--profile monitoring`), scrapes `/metrics` on every instance |
| postgres-primary | 55432 | Primary database |
| postgres-replica | 55433 | Hot standby (streaming replication) |

## Fault-tolerance mechanisms

Hardware / infrastructure (assignment §8, two required):

1. **Service replication + load balancing** — round robin over healthy instances (`app/gateway.py`)
2. **Database replication** — PostgreSQL streaming replication with read failover to the standby (`app/db.py`)
3. **Self-healing** — container restart policy, the Compose analogue of a Kubernetes ReplicaSet
4. **Storage checksums** — `initdb --data-checksums`, so a corrupted page is detected on read (`docker-compose.yml`)
5. **Independent monitoring** — Prometheus `up` detects a silent instance without relying on the gateway (`monitoring/prometheus.yml`)

RAID and ECC memory are covered as documented mechanisms in `REPORT.md` §6.

Software (assignment §9, four required):

1. **Retry with exponential backoff and full jitter** — `call()` in `app/ft.py`
2. **Timeouts** — per-attempt `asyncio.wait_for`, same file
3. **Circuit breaker** — closed / open / half-open, same file
4. **Health checks** — the gateway polls `/health` every second; the transition timestamp is the measured detection time
5. **Idempotent processing + duplicate detection** — `UNIQUE idempotency_key` + `ON CONFLICT DO NOTHING` (`app/payment.py`)
6. **Checkpointing, rollback and recovery** — a `pending` checkpoint is written before the charge and reconciled by a boot-time and periodic sweep (`app/payment.py`)
7. **Graceful degradation** — stale-but-flagged reads when the database or a whole service is unreachable (`app/gateway.py`, `app/transcript.py`)
8. **Checkpointing of long-running jobs** — timetable generation saves its progress every 10 placements under a lease; when the owner dies, a live replica adopts the job (`FOR UPDATE SKIP LOCKED`) and resumes it from the checkpoint (`app/timetable.py`, `app/schedule.py`)

## Layout

    app/            FastAPI services
      ft.py         retry, timeout, circuit breaker  <- the core, dependency-free
      db.py         Postgres access, primary -> replica read failover
      eventlog.py   JSONL event log (the source of every metric) + Prometheus exposition
      chaos.py      in-process fault injection control plane
      service.py    shared app factory: request logging, /metrics, error mapping
      schedule.py   deterministic timetable placement, dependency-free
      gateway.py student.py payment.py transcript.py timetable.py
    scripts/        experiment harness
      workload.ts   load generator, records every request
      scenarios.ts  the six required failure scenarios
      metrics.ts    MTTF / MTBF / MTTR / availability, with definitions
      run.ts        one experiment end to end, writes raw data + a report
      demo.sh       live demonstration of four failure-and-recovery scenarios
    tests/          self-checks: test_ft.py (core), test_schedule.py, test_metrics.py
    monitoring/     Prometheus scrape configuration
    docs/           architecture diagram
    results/        one directory per experiment, each with its own REPORT.md
    REPORT.md       the final technical report

## Results and documentation

| Document | What it holds |
|---|---|
| `REPORT.md` | The technical report in the assignment's structure: requirements, fault model, reliability analysis (block diagrams, fault tree, FMEA), hardware and software design, results, discussion |
| `docs/ARCHITECTURE.md` | Deployment diagram, components, request flow |
| `results/EXPERIMENT-LOG.md` | Every run in execution order, one row each, regenerated from the raw metrics |
| `results/COMPARISON.md` | Baseline vs fault-tolerant: headline table, per-scenario analysis, campaign totals, theoretical vs measured availability, threats to validity |
| `results/METHODOLOGY.md` | Workload, timing, metric definitions, consistency checks, reproduction steps, and the campaign history including which defects forced re-runs |
| `results/<scenario>__<mode>/REPORT.md` | One self-contained report per run: what was injected, the timeline, measured results, which mechanisms fired, consistency verdicts |
| `results/<scenario>__<mode>/*.jsonl` | The raw per-request and per-event data every number is derived from |

Regenerate the comparison after any run:

    node --experimental-strip-types scripts/compare.ts

## Fault injection

    curl -X POST localhost:3011/chaos -d '{"latencyMs":3000}'   # service slowdown
    curl -X POST localhost:3011/chaos -d '{"failRate":0.5}'     # flaky upstream
    curl -X POST localhost:3011/chaos/crash                     # application crash
    curl -X POST localhost:3021/chaos -d '{"crashAfterCheckpoint":true}'  # interrupted transaction
    docker compose stop postgres-primary                        # database failure
    docker compose kill student-1 payment-1                     # node failure

    # interrupted timetable job: start one, then crash the instance that owns it
    curl -X POST localhost:8080/api/timetables -H 'content-type: application/json' -d '{"term":"2026-fall"}'
    curl -X POST localhost:3041/chaos/crash                     # if the answer said timetable-1
    curl localhost:8080/api/timetables/2026-fall                # state, owner, progress

`docker compose kill` is an operator stop and deliberately does **not** trip the
restart policy, which is what makes it a faithful "the node is gone" simulation.
An application crash must therefore be injected from inside the process
(`/chaos/crash`), not with `docker kill`.

## Measurement

Every service appends JSON lines to `logs/events.jsonl`:

    {"ts":…,"svc":"gateway","ft":1,"kind":"health","target":"http://student-1:3000","ok":false}
    {"ts":…,"svc":"gateway","ft":1,"kind":"attempt","target":"students","ok":false,"attempts":1}
    {"ts":…,"svc":"gateway","ft":1,"kind":"route","instance":"http://student-2:3000","attempts":2}
    {"ts":…,"svc":"payment-1","ft":1,"kind":"recovery","action":"duplicate_suppressed"}

`kind`: `request` `attempt` `upstream` `route` `health` `breaker` `recovery`
`degraded` `chaos` `db` `checkpoint`.

MTTF, MTBF, MTTR, availability, failure rate and detection/recovery times are all
derived from this file plus the per-request workload log. Definitions live at the
top of `scripts/metrics.ts`; no number in any report is asserted without raw data
behind it.

The same events are counted live per process and exposed on `GET /metrics` of every
service as `ft_events_total{kind, outcome}`, plus `ft_instance_up{target}` on the
gateway. Example queries are at the top of `monitoring/prometheus.yml`.

## Assumptions

* Trust authentication inside the Compose network (`pg/pg_hba.conf`) — the database
  is not reachable from outside it. Production would use scram-sha-256 with a
  replication-scoped entry.
* Writes go only to the primary; the standby serves reads. Automatic promotion of
  the standby is out of scope and is discussed as a limitation.
* One container models one node. The node-failure scenario kills the two containers
  designated as sharing a node.
* The "operator repair" at T+45s is issued in both versions so that baseline MTTR
  reflects a human response rather than infinity.

`results-typescript-prototype/` holds an earlier campaign run against a Node/TypeScript
implementation of the same services, kept only for comparison; the FastAPI
implementation in `app/` is the submitted system.
