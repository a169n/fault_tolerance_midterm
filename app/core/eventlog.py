"""Structured event log.

Every experiment metric (MTTF, MTBF, MTTR, availability, detection and recovery
time) is derived from this file, so it is the single source of truth for the
evaluation -- not the console output.
"""
from __future__ import annotations

import json
import os
import pathlib
import time
from collections import Counter
from typing import Dict

LOG_DIR = os.environ.get("LOG_DIR", "/logs")
SERVICE = os.environ.get("SERVICE_NAME", "unknown")

pathlib.Path(LOG_DIR).mkdir(parents=True, exist_ok=True)
_stream = open(pathlib.Path(LOG_DIR) / "events.jsonl", "a", buffering=1)

# Live view of the same events for Prometheus (GET /metrics). Counters live in
# process memory and restart from zero with the process, which Prometheus'
# rate() handles; the JSONL file stays the source of truth for the experiments.
_counts: Counter = Counter()
_instance_up: Dict[str, int] = {}


def ft_enabled() -> bool:
    """The single switch separating the baseline from the fault-tolerant system."""
    return os.environ.get("FT_ENABLED") == "1"


def now_ms() -> int:
    return int(time.time() * 1000)


def log(**event) -> None:
    """Append one event. `kind` is always set; the rest varies by event type.

    kind: request | attempt | upstream | route | health | breaker | recovery
          | degraded | chaos | db | checkpoint
    """
    _stream.write(
        json.dumps({"ts": now_ms(), "svc": SERVICE, "ft": 1 if ft_enabled() else 0, **event}) + "\n"
    )
    _counts[(event["kind"], _outcome(event))] += 1
    if event["kind"] == "health":
        _instance_up[event["target"]] = 1 if event["ok"] else 0


def _outcome(event: dict) -> str:
    """The one field that says what happened: retry_succeeded, open, stale_cache, 503, ..."""
    for key in ("action", "reason", "state", "status"):
        if event.get(key) is not None:
            return str(event[key])
    if "ok" in event:
        return "ok" if event["ok"] else "fail"
    return ""


def metrics_text() -> str:
    """Prometheus text exposition of every event this process has logged.

    ft_events_total{kind="recovery",outcome="retry_succeeded"} is the live
    counterpart of the per-run counts in results/*/REPORT.md. ft_instance_up is
    only exported by the gateway, the one process that runs health checks.
    """
    lines = ["# HELP ft_events_total Events logged, by kind and outcome.", "# TYPE ft_events_total counter"]
    lines += [f'ft_events_total{{svc="{SERVICE}",kind="{kind}",outcome="{outcome}"}} {n}'
              for (kind, outcome), n in sorted(_counts.items())]
    if _instance_up:
        lines += ["# HELP ft_instance_up Gateway health-check verdict per instance.", "# TYPE ft_instance_up gauge"]
        lines += [f'ft_instance_up{{target="{t}"}} {v}' for t, v in sorted(_instance_up.items())]
    return "\n".join(lines) + "\n"
