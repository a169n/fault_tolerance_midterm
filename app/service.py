"""Shared FastAPI wiring: request logging, service identification and pool lifecycle.

Used by all four services so that every one of them produces the same event-log
schema, which is what makes a single metrics calculator possible.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .eventlog import SERVICE, log
from .ft import UpstreamError


def create_app(with_db: bool = True, lifespan=None) -> FastAPI:
    if lifespan is None and with_db:
        from .db import close_pools, open_pools

        @asynccontextmanager
        async def _lifespan(app: FastAPI):
            await open_pools()
            yield
            await close_pools()

        lifespan = _lifespan

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.exception_handler(UpstreamError)
    async def _upstream(_: Request, exc: UpstreamError):
        return JSONResponse(status_code=exc.status or 503, content={"error": str(exc)})

    @app.middleware("http")
    async def _observe(request: Request, call_next):
        started = time.time()
        try:
            response = await call_next(request)
        except UpstreamError as exc:
            response = JSONResponse(status_code=exc.status or 503, content={"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - a crashing handler is still an observable failure
            response = JSONResponse(status_code=503, content={"error": str(exc)})
        ms = int((time.time() - started) * 1000)
        # One line per inbound request: this is what the metrics analysis consumes.
        if request.url.path != "/health":
            log(kind="request", target=f"{request.method} {request.url.path}",
                ok=response.status_code < 500, status=response.status_code, ms=ms)
        response.headers["x-served-by"] = SERVICE
        return response

    return app
