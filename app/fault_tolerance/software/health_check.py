from __future__ import annotations

import asyncio
import os
from typing import Dict, List

import httpx

from ...core.eventlog import log
from . import timeouts

INTERVAL_MS = int(os.environ.get("HEALTH_INTERVAL_MS", 1000))  # S4

_status: Dict[str, bool] = {}


def is_up(instance: str) -> bool:
    return _status.get(instance) is not False  # unprobed = up


def snapshot() -> Dict[str, bool]:
    return dict(_status)


async def _probe(client: httpx.AsyncClient, instance: str) -> None:
    try:
        response = await client.get(f"{instance}/health", timeout=timeouts.HEALTH_PROBE_S)
        up = response.status_code < 400
    except Exception:
        up = False
    was = _status.get(instance)
    if was != up:
        log(kind="health", target=instance, ok=up, transition=f"{was}->{up}")  # detection time
    _status[instance] = up


async def loop(client: httpx.AsyncClient, instances: List[str]) -> None:
    while True:
        await asyncio.gather(*(_probe(client, i) for i in instances))
        await asyncio.sleep(INTERVAL_MS / 1000)
