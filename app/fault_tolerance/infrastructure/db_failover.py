from __future__ import annotations

from typing import Any, Awaitable, Callable, List, Optional

from ...core.errors import UpstreamError
from ...core.eventlog import ft_enabled, log


async def read(query: Callable[[Any], Awaitable[List[Any]]], primary: Any, replica: Optional[Any]) -> List[Any]:
    try:
        return await query(primary)
    except Exception as exc:
        if not ft_enabled() or replica is None:  # baseline never uses the standby
            raise UpstreamError(str(exc), 503) from exc
        try:
            rows = await query(replica)  # H2: hot standby
            log(kind="degraded", target="db", reason="read_from_replica")
            return rows
        except Exception as exc2:
            raise UpstreamError(str(exc2), 503) from exc2
