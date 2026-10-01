"""Self-check for the Prometheus exposition in app/eventlog.py.

    python -m unittest tests.test_metrics
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("LOG_DIR", "./logs")

from app.eventlog import log, metrics_text  # noqa: E402


class MetricsTest(unittest.TestCase):
    def test_events_are_counted_by_kind_and_outcome(self):
        log(kind="recovery", target="payment", action="duplicate_suppressed")
        log(kind="recovery", target="payment", action="duplicate_suppressed")
        log(kind="request", target="GET /", ok=False, status=503, ms=4)
        log(kind="attempt", target="students", ok=False, attempts=1)
        text = metrics_text()
        self.assertIn('kind="recovery",outcome="duplicate_suppressed"} 2', text)
        self.assertIn('kind="request",outcome="503"} 1', text)
        self.assertIn('kind="attempt",outcome="fail"}', text)

    def test_health_transitions_become_an_instance_gauge(self):
        log(kind="health", target="http://student-9:3000", ok=True, transition="None->True")
        log(kind="health", target="http://student-9:3000", ok=False, transition="True->False")
        self.assertIn('ft_instance_up{target="http://student-9:3000"} 0', metrics_text())


if __name__ == "__main__":
    unittest.main()
