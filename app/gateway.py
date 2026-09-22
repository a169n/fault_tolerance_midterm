"""API Gateway / Load Balancer.

Hardware FT: round-robin across replicated service instances, so the loss of one
             instance (or one node) does not interrupt the service.
Software FT: health checks, retry + backoff, timeouts, circuit breaker,
             idempotency-key propagation, graceful degradation.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .eventlog import ft_enabled, log
from .ft import CircuitBreaker, UpstreamError, call
from .service import create_app


def _urls(value: Optional[str]) -> List[str]:
    return [u for u in (value or "").split(",") if u]


POOLS: Dict[str, List[str]] = {
    "students": _urls(os.environ.get("STUDENT_URLS")),
    "payments": _urls(os.environ.get("PAYMENT_URLS")),
    "transcripts": _urls(os.environ.get("TRANSCRIPT_URLS")),
}

HEALTH_INTERVAL_MS = int(os.environ.get("HEALTH_INTERVAL_MS", 1000))
STALE_MAX_MS = int(os.environ.get("STALE_MAX_MS", 60_000))

_client = httpx.AsyncClient(timeout=None)
_breakers: Dict[str, CircuitBreaker] = {}
_healthy: Dict[str, bool] = {}
_cursor: Dict[str, int] = {}
# Last known-good response per GET path. Served with 203 + degraded=true when every
# instance of a read-only service is unreachable. Stale data beats a 503 for
# transcripts; it would not be acceptable for payments, which is why only GETs are
# cached here.
_last_good: Dict[str, Dict[str, object]] = {}


def _breaker_for(pool: str) -> CircuitBreaker:
    if pool not in _breakers:
        _breakers[pool] = CircuitBreaker(pool)
    return _breakers[pool]


async def _probe(instance: str) -> None:
    try:
        response = await _client.get(f"{instance}/health", timeout=0.5)
        up = response.status_code < 400
    except Exception:  # noqa: BLE001
        up = False
    was = _healthy.get(instance)
    if was != up:
        # The timestamp of this transition is the measured DETECTION TIME.
        log(kind="health", target=instance, ok=up, transition=f"{was}->{up}")
    _healthy[instance] = up


async def _health_loop() -> None:
    instances = [i for pool in POOLS.values() for i in pool]
    while True:
        await asyncio.gather(*(_probe(i) for i in instances))
        await asyncio.sleep(HEALTH_INTERVAL_MS / 1000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_health_loop()) if ft_enabled() else None
    yield
    if task is not None:
        task.cancel()
    await _client.aclose()


app = create_app(with_db=False, lifespan=lifespan)


def _pick(pool: str) -> List[str]:
    """Returns the instance ring, rotated so a retry lands on the NEXT instance."""
    everyone = POOLS.get(pool) or []
    if not everyone:
        raise UpstreamError(f"no instances for {pool}", 502)
    # The baseline routes blindly and will happily send traffic to a dead instance.
    candidates = [i for i in everyone if _healthy.get(i) is not False] if ft_enabled() else everyone
    live = candidates or everyone
    n = _cursor.get(pool, 0) % len(live)
    _cursor[pool] = n + 1
    return live[n:] + live[:n]


@app.get("/health")
async def health():
    return {"ok": True, "ft": ft_enabled(), "instances": _healthy}


@app.api_route("/api/{pool}", methods=["GET", "POST"])
@app.api_route("/api/{pool}/{path:path}", methods=["GET", "POST"])
async def proxy(pool: str, request: Request, path: str = ""):
    if pool not in POOLS:
        return JSONResponse(status_code=404, content={"error": "unknown service"})

    method = request.method
    body = await request.body()
    target_path = f"/{path}" if path else "/"
    query = request.url.query
    # A retried POST must carry a stable key, otherwise the retry becomes a second charge.
    idem = request.headers.get("idempotency-key") or str(uuid.uuid4())
    ring = _pick(pool)
    chosen = {"instance": ring[0], "i": 0}

    async def attempt(timeout: Optional[float]):
        instance = ring[chosen["i"] % len(ring)]
        chosen["i"] += 1
        chosen["instance"] = instance
        url = f"{instance}{target_path}" + (f"?{query}" if query else "")
        try:
            response = await _client.request(
                method, url, content=body or None,
                headers={"content-type": "application/json", "idempotency-key": idem},
                timeout=timeout,
            )
        except Exception as exc:  # noqa: BLE001
            raise UpstreamError(str(exc), 0) from exc
        if response.status_code >= 500:
            raise UpstreamError(f"upstream {response.status_code}", response.status_code)
        try:
            return response.status_code, response.json()
        except Exception:  # noqa: BLE001
            return response.status_code, None

    try:
        (status, payload), attempts = await call(pool, attempt, _breaker_for(pool))
        # Which replica actually served the request -- the evidence for the
        # load-balancing and failover claims in the report.
        log(kind="route", target=pool, instance=chosen["instance"], ok=True, attempts=attempts)
        if attempts > 1:
            log(kind="recovery", target=pool, action="retry_succeeded", attempts=attempts)
        if method == "GET":
            _last_good[target_path] = {"body": payload, "at": time.time() * 1000}
        return JSONResponse(status_code=status, content=payload)
    except Exception as exc:  # noqa: BLE001
        stale = _last_good.get(target_path)
        if ft_enabled() and method == "GET" and stale and time.time() * 1000 - float(stale["at"]) < STALE_MAX_MS:
            age = int(time.time() * 1000 - float(stale["at"]))
            log(kind="degraded", target=pool, reason="stale_cache", ageMs=age)
            return JSONResponse(status_code=203, content={"degraded": True, "staleAgeMs": age, "data": stale["body"]})
        status = exc.status if isinstance(exc, UpstreamError) and exc.status >= 400 else 503
        return JSONResponse(status_code=status, content={"error": str(exc)})
