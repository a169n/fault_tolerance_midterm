import { readdirSync, readFileSync } from 'node:fs';

const RUNS = new URL('../reports/runs/', import.meta.url);
const only = process.argv[2];  // optional scenario name
const pct = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} %`);
const ms = (v: number | null) => (v == null ? 'n/a' : `${Math.round(v)} ms`);

const runs = readdirSync(RUNS)
  .filter((d) => d.includes('__') && (!only || d.startsWith(`${only}__`)))
  .map((d) => JSON.parse(readFileSync(new URL(`${d}/metrics.json`, RUNS), 'utf8')));

if (runs.length === 0) {
  console.log('usage: npm run metrics [-- <scenario>]   (no runs found in reports/runs/)');
  process.exit(1);
}

console.table(runs.map(({ scenario, mode, metrics: m, consistency: c }) => ({
  scenario, mode,
  requests: m.requests.total, failed: m.requests.failed,
  'avail (req)': pct(m.availability.requestBased), 'avail (time)': pct(m.availability.timeBased),
  detection: ms(m.response.detectionMs), MTTR: ms(m.reliability.mttrMs), p95: ms(m.response.p95Ms),
  'dup charges': c.duplicateCharges, orphans: c.orphanedPending,
})));

if (only) {  // one scenario: also show which mechanisms fired
  console.table(Object.fromEntries(runs.map(({ mode, metrics: m }) => {
    const { healthTransitions, ...counts } = m.mechanisms;
    return [mode, counts];
  })));
}
