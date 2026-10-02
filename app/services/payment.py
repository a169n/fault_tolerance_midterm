"""Payment Service -- the money path, and the only place where a lost or
duplicated operation has a real-world cost.

Software fault tolerance demonstrated here:
  * idempotent transaction processing / duplicate-request detection
    (UNIQUE idempotency_key + ON CONFLICT DO NOTHING)
  * checkpointing (a 'pending' row is durably written BEFORE the charge)
  * rollback and recovery (a sweep reconciles checkpoints orphaned by a crash)
"""
from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import chaos
from .db import close_pools, db_healthy, open_pools, read, to_jsonable, transaction, write
from .eventlog import ft_enabled, log
from .service import create_app

ORPHAN_AFTER_MS = int(os.environ.get("ORPHAN_AFTER_MS", 10_000))


async def recover_orphaned_checkpoints() -> None:
    """Crash recovery.

    A checkpoint left in 'pending' means the process died between writing the
    checkpoint and committing the charge: the money was never moved, so the
    checkpoint is rolled back. Without this sweep (the baseline) those rows stay
    'pending' forever and the ledger is permanently inconsistent.
    """
    if not ft_enabled():
        return
    try:
        rows = await write(
            """UPDATE payments SET state = 'rolled_back', updated_at = now()
               WHERE state = 'pending' AND created_at < now() - (%s || ' milliseconds')::interval
               RETURNING id, idempotency_key""",
            (str(ORPHAN_AFTER_MS),),
        )
        for row in rows:
            log(kind="recovery", target="payment", action="checkpoint_rolled_back", paymentId=str(row["id"]))
    except Exception as exc:  # noqa: BLE001
        log(kind="recovery", target="payment", ok=False, err=str(exc))


async def _sweep_loop() -> None:
    while True:
        await recover_orphaned_checkpoints()
        await asyncio.sleep(ORPHAN_AFTER_MS / 1000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pools()
    # Runs at boot (recovery after a crash) and periodically (recovery after a
    # database outage that made the previous sweep fail).
    task = asyncio.create_task(_sweep_loop())
    yield
    task.cancel()
    await close_pools()


app = create_app(lifespan=lifespan)
app.include_router(chaos.router)


@app.get("/health")
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


@app.post("/")
async def create_payment(body: dict, request: Request):
    await chaos.chaos_gate()
    try:
        amount = float(body.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not body.get("studentId") or amount <= 0:
        return JSONResponse(status_code=400, content={"error": "studentId and a positive amount are required"})

    # The baseline ignores the idempotency key entirely: every retry -- including
    # the client's own -- becomes a second charge.
    key = (request.headers.get("idempotency-key") or str(uuid.uuid4())) if ft_enabled() else str(uuid.uuid4())

    # --- checkpoint ---------------------------------------------------------
    inserted = await write(
        """INSERT INTO payments (idempotency_key, student_id, amount, state)
           VALUES (%s, %s, %s, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, state""",
        (key, body["studentId"], amount),
    )

    if not inserted:
        # Duplicate request detected: return the original outcome, charge nothing.
        existing = await read("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
        row = existing[0] if existing else {}
        log(kind="recovery", target="payment", action="duplicate_suppressed", paymentId=str(row.get("id")))
        return JSONResponse(status_code=200, content={**to_jsonable(row), "duplicate": True})

    payment_id = inserted[0]["id"]

    # --- injected crash between checkpoint and commit -----------------------
    if chaos.config["crashAfterCheckpoint"]:
        log(kind="chaos", action="crash_after_checkpoint", paymentId=str(payment_id))
        os._exit(1)

    # --- charge (atomic) ----------------------------------------------------
    try:
        async with transaction() as cur:
            await cur.execute("SELECT balance FROM students WHERE id = %s FOR UPDATE", (body["studentId"],))
            if await cur.fetchone() is None:
                return JSONResponse(status_code=404, content={"error": "student not found"})
            await cur.execute(
                "UPDATE students SET balance = balance + %s WHERE id = %s", (amount, body["studentId"])
            )
            await cur.execute(
                "UPDATE payments SET state = 'completed', updated_at = now() WHERE id = %s RETURNING *",
                (payment_id,),
            )
            result = await cur.fetchone()
        return JSONResponse(status_code=201, content=to_jsonable(result))
    except Exception:  # noqa: BLE001
        # The transaction already rolled back; mark the checkpoint so the sweep
        # does not have to guess later.
        try:
            await write("UPDATE payments SET state = 'failed', updated_at = now() WHERE id = %s", (payment_id,))
        except Exception:  # noqa: BLE001
            pass
        raise


@app.get("/{key}")
async def get_payment(key: str):
    rows = await read("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
    if not rows:
        return JSONResponse(status_code=404, content={"error": "payment not found"})
    return to_jsonable(rows[0])
