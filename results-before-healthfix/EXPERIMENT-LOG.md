# Experiment log

Every controlled run, in execution order. Each row links to a per-run report
containing the timeline, the raw data and the consistency checks. This file is
regenerated from the `metrics.json` of every run, so re-running a scenario
replaces its row instead of adding a second one.

The observation window is fixed at 70 s by the workload generator; the column is
shown so that any run whose window was distorted is visible rather than hidden.

| # | Scenario | Version | Requests | Failed | Avail. (req) | Avail. (time) | Detection | Recovery | MTTR | Dup. charges | Orphans | Window | Report |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Application crash | ft | 12118 | 0 | 100.00 % | 100.00 % | 85 ms | -- | n/a | 0 | 0 | 70.5 s | [report](app-crash__ft/REPORT.md) |
| 2 | Database failure | ft | 8918 | 472 | 94.71 % | 100.00 % | 278 ms | -- | n/a | 0 | 0 | 70.5 s | [report](db-failure__ft/REPORT.md) |
| 3 | Network / service timeout | ft | 8770 | 0 | 100.00 % | 100.00 % | 824 ms | -- | n/a | 0 | 0 | 70.5 s | [report](net-timeout__ft/REPORT.md) |
| 4 | Hardware / node failure | ft | 12469 | 0 | 100.00 % | 100.00 % | 253 ms | -- | n/a | 0 | 0 | 70.5 s | [report](node-failure__ft/REPORT.md) |
| 5 | Corrupted / lost transaction | ft | 12371 | 237 | 98.08 % | 100.00 % | 4 ms | -- | n/a | 0 | 0 | 70.5 s | [report](txn-interrupt__ft/REPORT.md) |
| 6 | High load | ft | 44020 | 0 | 100.00 % | 100.00 % | n/a | -- | n/a | 0 | 0 | 70.5 s | [report](high-load__ft/REPORT.md) |
| 7 | Application crash | baseline | 12002 | 1313 | 89.06 % | 100.00 % | 91 ms | -- | n/a | 446 | 0 | 70.5 s | [report](app-crash__baseline/REPORT.md) |
| 8 | Database failure | baseline | 6771 | 37 | 99.45 % | 97.83 % | 164 ms | 20380 ms | 10.1 s | 291 | 0 | 70.5 s | [report](db-failure__baseline/REPORT.md) |
| 9 | Network / service timeout | baseline | 7920 | 0 | 100.00 % | 100.00 % | n/a | -- | n/a | 297 | 0 | 70.5 s | [report](net-timeout__baseline/REPORT.md) |
| 10 | Hardware / node failure | baseline | 12133 | 2455 | 79.77 % | 100.00 % | 271 ms | -- | n/a | 345 | 0 | 70.5 s | [report](node-failure__baseline/REPORT.md) |
| 11 | Corrupted / lost transaction | baseline | 12392 | 2026 | 83.65 % | 100.00 % | 25 ms | -- | n/a | 298 | 2 | 70.5 s | [report](txn-interrupt__baseline/REPORT.md) |
| 12 | High load | baseline | 41367 | 95 | 99.77 % | 100.00 % | 49947 ms | -- | n/a | 1619 | 0 | 70.5 s | [report](high-load__baseline/REPORT.md) |
