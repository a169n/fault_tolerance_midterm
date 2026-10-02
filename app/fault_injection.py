from __future__ import annotations

import asyncio
import os
import random
import threading

from fastapi import APIRouter, HTTPException

from .core.eventlog import log

config = {
    "latencyMs": int(os.environ.get("CHAOS_LATENCY_MS", 0)),
    "failRate": float(os.environ.get("CHAOS_FAIL_RATE", 0)),
    "crashAfterCheckpoint": os.environ.get("CHAOS_CRASH_AFTER_CHECKPOINT") == "1",
}

router = APIRouter()


async def chaos_gate() -> None:
    if config["latencyMs"] > 0:
        await asyncio.sleep(config["latencyMs"] / 1000)
    if config["failRate"] > 0 and random.random() < config["failRate"]:
        raise HTTPException(status_code=503, detail="injected fault")


@router.get("/chaos")
async def get_chaos():
    return config


@router.post("/chaos")
async def set_chaos(body: dict):
    config.update(body or {})
    log(kind="chaos", action="configure", **config)
    return config


@router.post("/chaos/crash")
async def crash():
    log(kind="chaos", action="crash")
    threading.Timer(0.05, lambda: os._exit(1)).start()  # hard crash, no cleanup
    return {"crashing": True}
