"""Academic Records / Transcript Service.

Read-only, and therefore the natural place to demonstrate graceful degradation:
when the database is unreachable it serves the last known-good transcript with an
explicit `degraded` flag instead of failing the request.
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict

from fastapi.responses import JSONResponse

from . import chaos
from .db import db_healthy, read, to_jsonable
from .eventlog import ft_enabled, log
from .service import create_app

STALE_MAX_MS = int(os.environ.get("STALE_MAX_MS", 60_000))

app = create_app()
app.include_router(chaos.router)

_cache: Dict[str, Dict[str, Any]] = {}


@app.get("/health")
async def health():
    ok = await db_healthy()
    # Degraded-but-serving is still healthy under FT: the gateway should keep
    # sending reads here, because the cache can answer them.
    healthy = ok or ft_enabled()
    return JSONResponse(status_code=200 if healthy else 503,
                        content={"ok": ok, "degraded": not ok, "ft": ft_enabled()})


@app.get("/{student_id}")
async def transcript(student_id: str):
    await chaos.chaos_gate()
    try:
        rows = await read(
            "SELECT course, grade FROM grades WHERE student_id = %s ORDER BY course", (student_id,)
        )
        gpa = round(sum(float(r["grade"]) for r in rows) / len(rows), 2) if rows else 0
        body = {"studentId": student_id, "courses": to_jsonable(rows), "gpa": gpa}
        _cache[student_id] = {"body": body, "at": time.time() * 1000}
        return body
    except Exception:  # noqa: BLE001
        hit = _cache.get(student_id)
        if not ft_enabled() or hit is None or time.time() * 1000 - hit["at"] > STALE_MAX_MS:
            raise
        age = int(time.time() * 1000 - hit["at"])
        log(kind="degraded", target="transcript", reason="stale_cache", ageMs=age)
        return JSONResponse(status_code=203, content={"degraded": True, "staleAgeMs": age, "data": hit["body"]})
