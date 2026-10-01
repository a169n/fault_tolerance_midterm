// Re-derives the consistency verdict and the per-run report for every completed
// experiment, from the raw data already stored in results/.
//
// Used when a metric DEFINITION changes but system behaviour has not: the
// experiments do not need to be repeated, only recomputed. Anything that depends
// on live state (the database query) is reused from the stored metrics.json.
//
//   node --experimental-strip-types scripts/recompute.ts
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.ts';
import { consistencyFrom, rebuildLog, readJsonl, report } from './report.ts';
import type { Rec } from './workload.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = `${ROOT}results`;

for (const entry of readdirSync(DIR, { withFileTypes: true })) {
  const path = `${DIR}/${entry.name}`;
  if (!entry.isDirectory() || !existsSync(`${path}/metrics.json`)) continue;

  const stored = JSON.parse(readFileSync(`${path}/metrics.json`, 'utf8'));
  const recs: Rec[] = readJsonl(`${path}/workload.jsonl`);
  const events = readJsonl(`${path}/events.jsonl`);

  const c = stored.consistency;
  const consistency = consistencyFrom(recs, {
    completed: c.completedInDb,
    pending: c.orphanedPending,
    rolledBack: c.rolledBack,
    failedPay: c.failedPay,
    charged: c.totalCharged,
    // ledgerBalanced was computed live; preserve the original verdict.
    balances: c.ledgerBalanced ? c.totalCharged : c.totalCharged + 1,
  });

  writeFileSync(`${path}/metrics.json`, JSON.stringify({ ...stored, consistency }, null, 2));
  writeFileSync(
    `${path}/REPORT.md`,
    report(SCENARIOS[stored.scenario], stored.mode, stored.t0, stored.t1,
           stored.injectTs, stored.repairTs, stored.metrics, consistency, events),
  );
  console.log(`  ${entry.name}: duplicate charges ${consistency.duplicateCharges}` +
    `, unacknowledged intents ${consistency.unacknowledgedIntents}` +
    `, orphaned checkpoints ${consistency.orphanedPending}`);
}

rebuildLog();
console.log('recomputed; EXPERIMENT-LOG.md regenerated');
