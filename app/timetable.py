"""Timetable Service -- generates a term's timetable as a long-running job.

Generation takes seconds rather than milliseconds, so a crash part-way through is
a realistic failure, and this is the natural place to demonstrate CHECKPOINTING.

Software fault tolerance demonstrated here:
  * checkpointing   progress is durably saved every CHECKPOINT_EVERY placements
  * recovery        a job whose owner stopped heartbeating is adopted by a live
                    replica (FOR UPDATE SKIP LOCKED, so exactly one wins) and
                    resumed from its last checkpoint instead of from zero
  * fencing         an owner that lost its lease stops at its next checkpoint
  * idempotency     the term is the job key; re-submitting it starts nothing

The baseline keeps progress in memory only: a crash loses the work and leaves the
job 'running' forever, with nothing that will ever finish it.
"""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Set

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from . import chaos
from .db import close_pools, db_healthy, open_pools, read, to_jsonable, write
from .eventlog import SERVICE, ft_enabled, log
from .schedule import Placements, steps
from .service import create_app

STEP_MS = int(os.environ.get("TIMETABLE_STEP_MS", 50))
CHECKPOINT_EVERY = int(os.environ.get("TIMETABLE_CHECKPOINT_EVERY", 10))
LEASE_MS = int(os.environ.get("TIMETABLE_LEASE_MS", 3000))

# asyncio keeps only weak references to tasks; hold them until they finish.
_jobs: Set[asyncio.Task] = set()


async def _save(term: str, placed: Placements, state: str = "running") -> bool:
    """Writes the checkpoint and renews the lease. False means another replica has
    adopted the job meanwhile, and this one must stop."""
    rows = await write(
        """UPDATE timetable_jobs SET checkpoint = %s::jsonb, state = %s, heartbeat_at = now()
           WHERE term = %s AND owner = %s
           RETURNING term""",
        (json.dumps(placed), state, term, SERVICE),
    )
    return bool(rows)


async def _run(term: str, placed: Placements) -> None:
    """Runs a job to completion, starting from `placed` (empty for a new job)."""
    try:
        courses = await read("SELECT id, teacher, students FROM courses")
        rooms = await read("SELECT id, capacity FROM rooms")
        for _ in steps(courses, rooms, placed):
            await asyncio.sleep(STEP_MS / 1000)  # stands in for the expensive constraint search
            if ft_enabled() and len(placed) % CHECKPOINT_EVERY == 0:
                if not await _save(term, placed):
                    log(kind="recovery", target="timetable", action="lease_lost", term=term)
                    return
                log(kind="checkpoint", target="timetable", term=term, placed=len(placed))
        if await _save(term, placed, "done"):
            log(kind="checkpoint", target="timetable", term=term, placed=len(placed), state="done")
    except Exception as exc:  # noqa: BLE001 - under FT the lease expires and another replica resumes
        log(kind="recovery", target="timetable", ok=False, term=term, err=str(exc))


def _start(term: str, placed: Placements) -> None:
    task = asyncio.create_task(_run(term, placed))
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)


async def adopt_orphaned_job() -> None:
    """Crash recovery: claim one job whose owner has not heartbeaten within the
    lease, and resume it from its last checkpoint.

    Runs on every replica. SKIP LOCKED makes the claim atomic, so when several
    replicas sweep at once exactly one of them adopts the job.
    """
    try:
        rows = await write(
            """UPDATE timetable_jobs SET owner = %s, heartbeat_at = now()
               WHERE term = (SELECT term FROM timetable_jobs
                             WHERE state = 'running'
                               AND heartbeat_at < now() - (%s || ' milliseconds')::interval
                             ORDER BY heartbeat_at LIMIT 1
                             FOR UPDATE SKIP LOCKED)
               RETURNING term, checkpoint""",
            (SERVICE, str(LEASE_MS)),
        )
        for row in rows:
            placed = row["checkpoint"] or {}
            log(kind="recovery", target="timetable", action="job_resumed", term=row["term"], fromPlaced=len(placed))
            _start(row["term"], placed)
    except Exception as exc:  # noqa: BLE001
        log(kind="recovery", target="timetable", ok=False, err=str(exc))


async def _sweep_loop() -> None:
    while True:
        await adopt_orphaned_job()
        await asyncio.sleep(LEASE_MS / 2000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pools()
    sweep = asyncio.create_task(_sweep_loop()) if ft_enabled() else None
    yield
    if sweep is not None:
        sweep.cancel()
    await close_pools()


app = create_app(lifespan=lifespan)
app.include_router(chaos.router)


@app.get("/health")
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


@app.post("/")
async def create_job(body: dict):
    await chaos.chaos_gate()
    term = str(body.get("term") or "").strip()
    if not term:
        return JSONResponse(status_code=400, content={"error": "term is required"})
    rows = await write(
        """INSERT INTO timetable_jobs (term, owner) VALUES (%s, %s)
           ON CONFLICT (term) DO NOTHING
           RETURNING term""",
        (term, SERVICE),
    )
    if not rows:
        # Same term submitted again: report the existing job, start nothing.
        existing = await read("SELECT term, state, owner FROM timetable_jobs WHERE term = %s", (term,))
        return JSONResponse(status_code=200, content={**to_jsonable(existing[0] if existing else {"term": term}),
                                                      "duplicate": True})
    _start(term, {})
    return JSONResponse(status_code=202, content={"term": term, "state": "running", "owner": SERVICE})


@app.get("/{term}")
async def get_job(term: str):
    await chaos.chaos_gate()
    rows = await read(
        "SELECT term, state, owner, checkpoint, heartbeat_at, created_at FROM timetable_jobs WHERE term = %s",
        (term,),
    )
    if not rows:
        return JSONResponse(status_code=404, content={"error": "job not found"})
    job = rows[0]
    placed = job.pop("checkpoint") or {}
    total = (await read("SELECT count(*) AS n FROM courses"))[0]["n"]
    done = job["state"] == "done"
    return to_jsonable({
        **job,
        # Durable progress only: the baseline shows 0 until the very end, because
        # whatever it has computed so far would not survive a crash.
        "progress": f"{len(placed)}/{total}",
        "unplaced": [cid for cid, p in placed.items() if p is None] if done else None,
        "timetable": placed if done else None,
    })
