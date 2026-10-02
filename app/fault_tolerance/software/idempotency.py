from __future__ import annotations

import uuid
from typing import Mapping

from fastapi.responses import JSONResponse

from ...core.db import read, to_jsonable
from ...core.eventlog import ft_enabled, log


def forward_key(headers: Mapping[str, str]) -> str:
    return headers.get("idempotency-key") or str(uuid.uuid4())  # S5: gateway retries reuse it


def payment_key(headers: Mapping[str, str]) -> str:
    if not ft_enabled():
        return str(uuid.uuid4())  # baseline ignores the key
    return headers.get("idempotency-key") or str(uuid.uuid4())


async def original_response(key: str) -> JSONResponse:  # duplicate: no second charge
    existing = await read("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
    row = existing[0] if existing else {}
    log(kind="recovery", target="payment", action="duplicate_suppressed", paymentId=str(row.get("id")))
    return JSONResponse(status_code=200, content={**to_jsonable(row), "duplicate": True})
