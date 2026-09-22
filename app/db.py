"""Database access with primary -> replica read failover.

This is the software half of the hardware fault-tolerance story: PostgreSQL
streaming replication (docker-compose.yml) provides the redundant copy, and this
module is what actually uses it when the primary disappears.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import decimal
import os
from typing import Any, Dict, List, Optional, Sequence

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .eventlog import log, ft_enabled
from .ft import UpstreamError

Row = Dict[str, Any]

# Without FT the pool waits effectively forever for a dead primary -- that hang is
# the baseline behaviour we want to measure. The client gives up after 10 s.
_ACQUIRE_TIMEOUT = 1.0 if ft_enabled() else 60.0

_primary = AsyncConnectionPool(
    os.environ["DATABASE_URL"], min_size=1, max_size=10, timeout=_ACQUIRE_TIMEOUT, open=False
)
_replica = (
    AsyncConnectionPool(
        os.environ["DATABASE_REPLICA_URL"], min_size=1, max_size=5, timeout=_ACQUIRE_TIMEOUT, open=False
    )
    if os.environ.get("DATABASE_REPLICA_URL")
    else None
)


async def open_pools() -> None:
    """Opened without waiting, so a service still starts when the database is down."""
    await _primary.open(wait=False)
    if _replica is not None:
        await _replica.open(wait=False)


async def close_pools() -> None:
    await _primary.close()
    if _replica is not None:
        await _replica.close()


def to_jsonable(value: Any) -> Any:
    """NUMERIC and TIMESTAMPTZ are not JSON types; convert rather than let the
    response blow up at serialisation time."""
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    return value


async def _query(pool: AsyncConnectionPool, sql: str, params: Sequence[Any]) -> List[Row]:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            if cur.description is None:
                return []
            return await cur.fetchall()


async def read(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    """Read query. With FT enabled, falls back to the hot standby if the primary is down."""
    try:
        return await _query(_primary, sql, params)
    except Exception as exc:  # noqa: BLE001
        if not ft_enabled() or _replica is None:
            raise UpstreamError(str(exc), 503) from exc
        try:
            rows = await _query(_replica, sql, params)
            log(kind="degraded", target="db", reason="read_from_replica")
            return rows
        except Exception as exc2:  # noqa: BLE001
            raise UpstreamError(str(exc2), 503) from exc2


async def write(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    """Write query. Writes only go to the primary -- a hot standby is read-only."""
    try:
        return await _query(_primary, sql, params)
    except Exception as exc:  # noqa: BLE001
        raise UpstreamError(str(exc), 503) from exc


class transaction:
    """Async context manager yielding a cursor inside a single transaction.

    psycopg commits when the block exits cleanly and rolls back on any exception,
    which is the atomicity guarantee both versions rely on. The difference between
    baseline and FT is the checkpointing and crash recovery built around it.
    """

    def __init__(self) -> None:
        self._conn_ctx = None
        self._cur_ctx = None

    async def __aenter__(self):
        self._conn_ctx = _primary.connection()
        conn = await self._conn_ctx.__aenter__()
        self._cur_ctx = conn.cursor(row_factory=dict_row)
        return await self._cur_ctx.__aenter__()

    async def __aexit__(self, exc_type, exc, tb):
        await self._cur_ctx.__aexit__(exc_type, exc, tb)
        result = await self._conn_ctx.__aexit__(exc_type, exc, tb)
        if exc_type is not None:
            log(kind="recovery", target="tx", action="rollback", err=str(exc))
        return result


# A health check must answer well inside the prober's budget (the gateway probes
# with a 500 ms timeout). Without its own tighter deadline this probe inherits the
# database's latency, and a service that is merely waiting on a slow dependency
# reports itself dead -- which is how the transcript service was being taken out of
# rotation during the database-failure experiment even though it could still serve
# its cache.
HEALTH_PROBE_TIMEOUT = 0.3


async def db_healthy() -> bool:
    """Liveness probe used by /health so the gateway can detect a database outage."""
    try:
        await asyncio.wait_for(_query(_primary, "SELECT 1", ()), timeout=HEALTH_PROBE_TIMEOUT)
        return True
    except Exception:  # noqa: BLE001
        return False
