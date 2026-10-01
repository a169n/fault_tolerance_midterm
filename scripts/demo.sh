#!/usr/bin/env bash
# Live demonstration of failure and recovery (assignment §12: at least three
# scenarios). Run it against the fault-tolerant version first, then against the
# baseline to show the contrast:
#
#   npm run up:ft        && bash scripts/demo.sh
#   npm run up:baseline  && bash scripts/demo.sh
#   bash scripts/demo.sh timetable      # just one: app-crash | db-failure | node-failure | timetable
#
# Each scenario prints the HTTP status codes clients get before, during and after
# the fault, e.g. "200 x40" (all fine) or "200 x20  503 x20" (half the calls lost).
set -uo pipefail
cd "$(dirname "$0")/.."
GW=http://localhost:8080
PAY='{"studentId":"s7","amount":100}'

scenario() { node --experimental-strip-types scripts/scenarios.ts "$@" >/dev/null; }
title()    { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
mode()     { curl -s --max-time 2 "$GW/health" | grep -o '"ft":[a-z]*'; }

# probe N METHOD PATH [BODY] -- N sequential calls through the gateway, printed as
# a status histogram. 000 means the client gave up (3 s): the call hung.
probe() {
  for i in $(seq "$1"); do
    curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 -X "$2" \
      -H 'content-type: application/json' -H "idempotency-key: demo-$$-$RANDOM-$i" \
      ${4:+-d "$4"} "$GW$3"
  done | sort | uniq -c | awk '{printf "%s x%s  ", $2, $1} END {print ""}'
}

app_crash() {
  title "Application crash: student-1 kills its own process"
  echo "before   students: $(probe 20 GET /api/students/s7)"
  scenario app-crash inject; sleep 0.5
  echo "during   students: $(probe 40 GET /api/students/s7)"
  echo "         gateway view: $(curl -s --max-time 2 "$GW/health" | grep -o '"instances":{[^}]*}')"
  sleep 8
  echo "after 8s students: $(probe 20 GET /api/students/s7)   (FT: restart policy brought it back)"
  scenario app-crash repair
}

db_failure() {
  title "Database failure: the PostgreSQL primary is stopped"
  echo "before   students: $(probe 10 GET /api/students/s7)  transcripts: $(probe 5 GET /api/transcripts/s7)  payments: $(probe 3 POST /api/payments "$PAY")"
  scenario db-failure inject; sleep 2
  echo "during   students: $(probe 5 GET /api/students/s7)  transcripts: $(probe 5 GET /api/transcripts/s7)  payments: $(probe 3 POST /api/payments "$PAY")"
  echo "         FT: reads from the standby (200) or stale cache (203); writes fail fast (503) instead of hanging (000)"
  scenario db-failure repair; sleep 6
  echo "after    students: $(probe 10 GET /api/students/s7)  transcripts: $(probe 5 GET /api/transcripts/s7)  payments: $(probe 3 POST /api/payments "$PAY")"
}

node_failure() {
  title "Node failure: student-1 and payment-1 are killed together"
  echo "before   students: $(probe 20 GET /api/students/s7)  payments: $(probe 10 POST /api/payments "$PAY")"
  scenario node-failure inject; sleep 0.5
  echo "during   students: $(probe 20 GET /api/students/s7)  payments: $(probe 10 POST /api/payments "$PAY")"
  echo "         FT: the surviving node carries everything; capacity drops, availability does not"
  scenario node-failure repair; sleep 5
  echo "after    students: $(probe 20 GET /api/students/s7)  payments: $(probe 10 POST /api/payments "$PAY")"
}

timetable() {
  title "Timetable job interrupted: the instance generating it crashes mid-job"
  local term="demo-$(date +%s)" owner
  owner=$(curl -s -X POST "$GW/api/timetables" -H 'content-type: application/json' \
    -d "{\"term\":\"$term\"}" | grep -o 'timetable-[12]')
  [ -n "$owner" ] || { echo "could not start a job -- is the platform up?"; return; }
  status() { curl -s --max-time 3 "$GW/api/timetables/$term" | grep -o '"\(state\|owner\|progress\)":"[^"]*"' | tr '\n' ' '; }
  echo "job $term started on $owner"
  sleep 2; echo "  t+2s   $(status)"
  curl -s -X POST "http://localhost:304${owner##*-}/chaos/crash" >/dev/null
  echo "  $owner crashed"
  for i in $(seq 3 16); do sleep 1; echo "  t+${i}s  $(status)"; done
  echo "  FT: the job resumes from its last checkpoint on a live replica and reaches done"
  echo "  baseline: progress stays 0/120 and the job is 'running' forever"
  docker compose start "$owner" >/dev/null 2>&1
}

echo "deployed version: $(mode)"
case "${1:-all}" in
  app-crash) app_crash ;;
  db-failure) db_failure ;;
  node-failure) node_failure ;;
  timetable) timetable ;;
  all)
    for s in app_crash db_failure node_failure timetable; do
      $s
      read -rp $'\npress Enter for the next scenario ' _
    done ;;
  *) echo "usage: bash scripts/demo.sh [app-crash|db-failure|node-failure|timetable]"; exit 1 ;;
esac
