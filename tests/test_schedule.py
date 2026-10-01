"""Self-check for timetable generation (app/schedule.py).

Two invariants: the generated timetable is valid, and resuming from a checkpoint
reproduces the uninterrupted result -- the second is what makes the timetable
service's crash recovery correct rather than merely "finishing somehow".

    python -m unittest tests.test_schedule
"""
from __future__ import annotations

import itertools
import json
import unittest

from app.schedule import steps

# Mirrors the seed data in sql/20-timetable.sql.
ROOMS = [{"id": rid, "capacity": cap} for rid, cap in [
    ("R101", 25), ("R102", 25), ("R201", 40), ("R202", 40), ("R203", 40),
    ("R301", 60), ("R302", 60), ("R401", 80), ("HALL-A", 100), ("HALL-B", 150),
]]
COURSES = [{"id": f"C{i:03d}", "teacher": f"T{i % 40}", "students": 10 + (i * 37) % 90} for i in range(1, 121)]


def build(placed=None):
    placed = {} if placed is None else placed
    for _ in steps(COURSES, ROOMS, placed):
        pass
    return placed


class ScheduleTest(unittest.TestCase):
    def test_every_course_is_placed_without_a_clash(self):
        timetable = build()
        course = {c["id"]: c for c in COURSES}
        capacity = {r["id"]: r["capacity"] for r in ROOMS}

        self.assertEqual(len(timetable), len(COURSES))
        self.assertNotIn(None, timetable.values(), "the seeded term must be fully schedulable")
        rooms_used = [tuple(p) for p in timetable.values()]
        self.assertEqual(len(set(rooms_used)), len(rooms_used), "a room is double-booked")
        teachers = [(course[cid]["teacher"], slot) for cid, (slot, _) in timetable.items()]
        self.assertEqual(len(set(teachers)), len(teachers), "a teacher is double-booked")
        for cid, (_, room) in timetable.items():
            self.assertGreaterEqual(capacity[room], course[cid]["students"], f"{cid} does not fit {room}")

    def test_resuming_from_a_checkpoint_gives_the_same_timetable(self):
        full = build()
        for crash_after in (1, 37, 119):
            placed = {}
            for _ in itertools.islice(steps(COURSES, ROOMS, placed), crash_after):
                pass
            # Round-trip through JSON: this is exactly what survives in the database.
            checkpoint = json.loads(json.dumps(placed))
            self.assertEqual(build(checkpoint), full, f"resume after {crash_after} placements diverged")


if __name__ == "__main__":
    unittest.main()
