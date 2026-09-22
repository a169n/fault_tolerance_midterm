#!/usr/bin/env bash
# Runs all six required failure scenarios against whichever version is currently
# deployed. Use npm run up:baseline / up:ft to choose the version first.
set -uo pipefail
cd "$(dirname "$0")/.."
for s in app-crash db-failure net-timeout node-failure txn-interrupt high-load; do
  node --experimental-strip-types scripts/run.ts "$s" || echo "!! $s failed, continuing"
done
echo
echo "campaign finished -- see results/EXPERIMENT-LOG.md"
