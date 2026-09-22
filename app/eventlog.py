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

LOG_DIR = os.environ.get("LOG_DIR", "/logs")
SERVICE = os.environ.get("SERVICE_NAME", "unknown")

pathlib.Path(LOG_DIR).mkdir(parents=True, exist_ok=True)
_stream = open(pathlib.Path(LOG_DIR) / "events.jsonl", "a", buffering=1)


def ft_enabled() -> bool:
    """The single switch separating the baseline from the fault-tolerant system."""
    return os.environ.get("FT_ENABLED") == "1"


def now_ms() -> int:
    return int(time.time() * 1000)


def log(**event) -> None:
    """Append one event. `kind` is always set; the rest varies by event type.

    kind: request | attempt | upstream | route | health | breaker | recovery
          | degraded | chaos | db
    """
    _stream.write(
        json.dumps({"ts": now_ms(), "svc": SERVICE, "ft": 1 if ft_enabled() else 0, **event}) + "\n"
    )
