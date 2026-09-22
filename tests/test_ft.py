"""Self-check for the fault-tolerance core.

If retry, backoff, the circuit breaker or the baseline/FT gate ever break, every
experiment result built on them is meaningless -- so these are the invariants
worth a test. Standard library only: no pytest, no fixtures, no installed deps.

    python3 -m unittest discover -s tests -t .
"""
from __future__ import annotations

import asyncio
import os
import time
import unittest

os.environ.setdefault("LOG_DIR", "./logs")
os.environ.setdefault("FT_TIMEOUT_MS", "50")

from app.ft import CircuitBreaker, UpstreamError, call  # noqa: E402


def ft(on: bool) -> None:
    os.environ["FT_ENABLED"] = "1" if on else "0"


class CircuitBreakerTest(unittest.TestCase):
    def test_opens_at_threshold_and_half_opens_after_cooldown(self):
        cb = CircuitBreaker("t", threshold=3, cooldown_ms=50)
        self.assertEqual(cb.state(), "closed")
        cb.failure()
        cb.failure()
        self.assertEqual(cb.state(), "closed")
        cb.failure()
        self.assertEqual(cb.state(), "open")
        self.assertEqual(cb.state(time.time() * 1000 + 100), "half-open")
        cb.success()
        self.assertEqual(cb.state(), "closed")


class CallTest(unittest.IsolatedAsyncioTestCase):
    async def test_ft_retries_a_transient_failure_until_it_succeeds(self):
        ft(True)
        calls = {"n": 0}

        async def flaky(_timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise UpstreamError("boom", 503)
            return "ok"

        value, attempts = await call("t", flaky)
        self.assertEqual(value, "ok")
        self.assertEqual(attempts, 3)
        self.assertEqual(calls["n"], 3)

    async def test_baseline_does_not_retry_the_same_failure(self):
        ft(False)
        calls = {"n": 0}

        async def always_fails(_timeout):
            calls["n"] += 1
            raise UpstreamError("boom", 503)

        with self.assertRaises(UpstreamError):
            await call("t", always_fails)
        self.assertEqual(calls["n"], 1)

    async def test_ft_never_retries_a_4xx(self):
        ft(True)
        calls = {"n": 0}

        async def bad_request(_timeout):
            calls["n"] += 1
            raise UpstreamError("bad request", 400)

        with self.assertRaises(UpstreamError):
            await call("t", bad_request)
        self.assertEqual(calls["n"], 1)

    async def test_open_breaker_fails_fast_without_touching_the_upstream(self):
        ft(True)
        cb = CircuitBreaker("t", threshold=1, cooldown_ms=10_000)
        cb.failure()
        calls = {"n": 0}

        async def never_called(_timeout):
            calls["n"] += 1
            return "ok"

        with self.assertRaises(UpstreamError):
            await call("t", never_called, cb)
        self.assertEqual(calls["n"], 0)

    async def test_per_attempt_timeout_aborts_a_hung_upstream(self):
        ft(True)
        started = time.time()

        async def hangs(_timeout):
            # A dependency that would hang for 10 s. The baseline waits it out; FT aborts.
            await asyncio.sleep(10)
            return "too late"

        with self.assertRaises(asyncio.TimeoutError):
            await call("t", hangs)
        self.assertLess(time.time() - started, 5, "must abort long before the upstream would answer")


if __name__ == "__main__":
    unittest.main()
