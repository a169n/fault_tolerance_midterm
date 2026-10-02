-- Timetable generation (app/timetable.py).
--
-- Init scripts only run on an empty data directory: after pulling this file,
-- recreate the volumes once with `docker compose down -v`.

CREATE TABLE rooms (
  id       TEXT PRIMARY KEY,
  capacity INT  NOT NULL
);

CREATE TABLE courses (
  id       TEXT PRIMARY KEY,
  teacher  TEXT NOT NULL,
  students INT  NOT NULL
);

-- One row per generation job. The term is the job key, so a re-submitted term
-- (a client or gateway retry) is recognised instead of starting a second job.
-- `checkpoint` is the durable progress (course id -> [slot, room]); `owner` and
-- `heartbeat_at` form the lease that lets a live replica adopt the job of a dead one.
CREATE TABLE timetable_jobs (
  term         TEXT PRIMARY KEY,
  state        TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done')),
  owner        TEXT NOT NULL,
  checkpoint   JSONB NOT NULL DEFAULT '{}',
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX timetable_jobs_lease_idx ON timetable_jobs (state, heartbeat_at);

-- tests/test_schedule.py mirrors this data and checks the term is fully schedulable.
INSERT INTO rooms (id, capacity) VALUES
  ('R101', 25), ('R102', 25), ('R201', 40), ('R202', 40), ('R203', 40),
  ('R301', 60), ('R302', 60), ('R401', 80), ('HALL-A', 100), ('HALL-B', 150);

INSERT INTO courses (id, teacher, students)
SELECT 'C' || lpad(i::text, 3, '0'), 'T' || (i % 40), 10 + (i * 37) % 90
FROM generate_series(1, 120) AS i;
