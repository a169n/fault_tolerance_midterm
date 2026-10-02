from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

from fastapi.responses import JSONResponse

from ...core.eventlog import ft_enabled, log

STALE_MAX_MS = int(os.environ.get("STALE_MAX_MS", 60_000))  # S7


class StaleCache:
    def __init__(self) -> None:
        self._entries: Dict[str, Dict[str, Any]] = {}

    def remember(self, key: str, body: Any) -> None:
        self._entries[key] = {"body": body, "at": time.time() * 1000}

    def fallback(self, key: str, target: str) -> Optional[JSONResponse]:
        hit = self._entries.get(key)
        if not ft_enabled() or hit is None:
            return None
        age = int(time.time() * 1000 - hit["at"])
        if age >= STALE_MAX_MS:
            return None
        log(kind="degraded", target=target, reason="stale_cache", ageMs=age)
        return JSONResponse(status_code=203, content={"degraded": True, "staleAgeMs": age, "data": hit["body"]})
