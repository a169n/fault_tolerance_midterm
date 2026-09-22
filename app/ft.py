"""Core software fault-tolerance primitives.

Every mechanism here is gated on ft_enabled(). The baseline system and the
fault-tolerant system are THE SAME IMAGE started with FT_ENABLED=0 or 1, so any
measured difference is attributable to these mechanisms and nothing else.

This module deliberately has no third-party dependencies, so the self-check in
tests/test_ft.py runs without installing anything.
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from typing import Awaitable, Callable, Optional, Tuple, TypeVar

from .eventlog import log, ft_enabled

T = TypeVar("T")

RETRIES = int(os.environ.get("FT_RETRIES", 3))
BACKOFF_MS = int(os.environ.get("FT_BACKOFF_MS", 50))
TIMEOUT_MS = int(os.environ.get("FT_TIMEOUT_MS", 800))
CB_THRESHOLD = int(os.environ.get("FT_CB_THRESHOLD", 5))
CB_COOLDOWN_MS = int(os.environ.get("FT_CB_COOLDOWN_MS", 5000))


class UpstreamError(Exception):
    """An upstream failure carrying an HTTP status; status 0 means transport-level."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


def _retryable(exc: BaseException) -> bool:
    """5xx and transport errors are transient; 4xx is the caller's fault, never retried."""
    if isinstance(exc, UpstreamError):
        return exc.status == 0 or exc.status >= 500
    return True


class CircuitBreaker:
    """Opens after `threshold` consecutive failures, stays open for `cooldown_ms`,
    then admits a single trial request (half-open)."""

    def __init__(self, name: str, threshold: int = CB_THRESHOLD, cooldown_ms: int = CB_COOLDOWN_MS) -> None:
        self.name = name
        self.threshold = threshold
        self.cooldown_ms = cooldown_ms
        self.failures = 0
        self.last_failure_at = 0.0

    def state(self, now_ms_: Optional[float] = None) -> str:
        now = time.time() * 1000 if now_ms_ is None else now_ms_
        if self.failures < self.threshold:
            return "closed"
        return "half-open" if now - self.last_failure_at >= self.cooldown_ms else "open"

    def success(self) -> None:
        if self.failures >= self.threshold:
            log(kind="breaker", target=self.name, state="closed")
        self.failures = 0

    def failure(self) -> None:
        self.failures += 1
        self.last_failure_at = time.time() * 1000
        if self.failures == self.threshold:
            log(kind="breaker", target=self.name, state="open")


async def call(
    target: str,
    fn: Callable[[Optional[float]], Awaitable[T]],
    breaker: Optional[CircuitBreaker] = None,
) -> Tuple[T, int]:
    """The single entry point for every cross-service / cross-process call.

    `fn` receives a per-attempt timeout in SECONDS, or None for "wait as long as
    the dependency takes" (the baseline).

    FT_ENABLED=0 -> one attempt, no timeout, no breaker: the call hangs exactly as
                    long as the broken dependency hangs. This is the baseline.
    FT_ENABLED=1 -> circuit breaker + per-attempt timeout + retry with exponential
                    backoff and full jitter.

    Retrying a POST is only safe because the caller propagates an Idempotency-Key
    and payment-svc deduplicates on it (see app/payment.py).

    Returns (value, attempts_used).
    """
    started = time.time() * 1000

    if not ft_enabled():
        return await fn(None), 1

    if breaker is not None and breaker.state() == "open":
        log(kind="upstream", target=target, ok=False, err="circuit_open", ms=0, attempts=0, breaker="open")
        raise UpstreamError(f"circuit open for {target}", 503)

    last_error: Optional[BaseException] = None
    for attempt in range(1, RETRIES + 1):
        try:
            value = await asyncio.wait_for(fn(TIMEOUT_MS / 1000), timeout=TIMEOUT_MS / 1000)
            if breaker is not None:
                breaker.success()
            ms = int(time.time() * 1000 - started)
            log(kind="upstream", target=target, ok=True, ms=ms, attempts=attempt,
                breaker=None if breaker is None else breaker.state())
            return value, attempt
        except (Exception, asyncio.TimeoutError) as exc:  # noqa: BLE001 - any failure is a failure
            last_error = exc
            if breaker is not None:
                breaker.failure()
            # Earliest evidence of the fault: this timestamp is what detection time
            # is measured from when the fault is fully masked from clients.
            log(kind="attempt", target=target, ok=False, attempts=attempt,
                breaker=None if breaker is None else breaker.state(),
                err=type(exc).__name__ if isinstance(exc, asyncio.TimeoutError) else str(exc))
            if not _retryable(exc) or attempt == RETRIES:
                break
            # Exponential backoff with full jitter: prevents retry storms from
            # synchronising and turning a partial outage into a total one.
            await asyncio.sleep(random.random() * (BACKOFF_MS / 1000) * 2 ** (attempt - 1))

    ms = int(time.time() * 1000 - started)
    log(kind="upstream", target=target, ok=False, ms=ms, attempts=RETRIES,
        breaker=None if breaker is None else breaker.state(), err=str(last_error))
    raise last_error  # type: ignore[misc]
