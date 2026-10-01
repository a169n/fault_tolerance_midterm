// Report rendering and the consistency calculation, shared by scripts/run.ts
// (which measures) and scripts/recompute.ts (which re-derives them from stored
// raw data when a definition changes, without re-running the experiments).
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SCENARIOS } from './scenarios.ts';
import type { Rec } from './workload.ts';
import type { Metrics } from './metrics.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Raw data is stored gzipped (20x smaller); read either form transparently. */
export function readJsonl(path: string): any[] {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : gunzipSync(readFileSync(`${path}.gz`)).toString('utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function writeJsonlGz(path: string, rows: unknown[]): void {
  writeFileSync(`${path}.gz`, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
}

export const iso = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
export const ms = (v: number | null | undefined) => (v == null ? 'n/a' : `${v} ms`);
export const s1 = (v: number | null | undefined) => (v == null ? 'n/a' : `${(v / 1000).toFixed(1)} s`);
export const pctStr = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} %`);

export type Ledger = {
  completed: number; pending: number; rolledBack: number; failedPay: number;
  charged: number; balances: number;
};

/**
 * Data-consistency verdict for one run.
 *
 * Duplicates are counted PER INTENT, not by subtracting aggregates. A run can
 * contain both duplicate charges and lost transactions at the same time, and in
 * aggregate the two cancel out and hide each other -- an earlier version of this
 * calculation reported zero duplicates for baseline runs that had hundreds.
 *
 * The discriminator is the HTTP status the client received:
 *   201  a new charge was created for this request
 *   200  the request was recognised as a duplicate and nothing was charged
 * So a second 201 for the same intent is, by definition, a second charge. The
 * baseline never returns 200 because it ignores the idempotency key entirely.
 *
 *   duplicateCharges       money taken more than once for one intent (exact,
 *                          from the client's own observations)
 *   unacknowledgedIntents  intents for which the client never saw a charge
 *                          confirmed. Some may have been charged server-side with
 *                          the response lost, so this is an upper bound on lost
 *                          transactions, not an exact count.
 *   orphanedPending        checkpoints left half-finished in the database (exact)
 */
export function consistencyFrom(recs: Rec[], ledger: Ledger) {
  const payments = recs.filter((r) => r.op === 'payments');
  const chargesPerIntent = new Map<string, number>();
  const intents = new Set<string>();
  for (const r of payments) {
    const intent = String(r.intent);
    intents.add(intent);
    if (r.status === 201) chargesPerIntent.set(intent, (chargesPerIntent.get(intent) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const n of chargesPerIntent.values()) duplicates += Math.max(0, n - 1);

  return {
    paymentRequestsSent: payments.length,
    paymentRequestsAccepted: payments.filter((r) => r.ok).length,
    distinctPaymentIntents: intents.size,
    deduplicatedResponses: payments.filter((r) => r.status === 200).length,
    duplicateCharges: duplicates,
    unacknowledgedIntents: intents.size - chargesPerIntent.size,
    completedInDb: ledger.completed,
    // Cross-check against the database: the two counts should agree once
    // unacknowledged intents are allowed for.
    dbVsIntents: ledger.completed - intents.size,
    orphanedPending: ledger.pending,
    rolledBack: ledger.rolledBack,
    failedPay: ledger.failedPay,
    totalCharged: ledger.charged,
    ledgerBalanced: ledger.charged === ledger.balances,
  };
}

export function report(sc: any, mode: string, t0: number, t1: number, injectTs: number, repairTs: number, m: Metrics, c: any, events: any[]): string {
  const rel = (ts: number) => `T+${((ts - t0) / 1000).toFixed(1)}s`;
  const rows: Array<[number, string]> = [
    [t0, `| ${rel(t0)} | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |`],
    [injectTs, `| ${rel(injectTs)} | **fault injected** | ${sc.injection.split('.')[0]}. |`],
    [repairTs, `| ${rel(repairTs)} | operator repair issued | ${mode === 'ft' ? 'usually a no-op: the system had already healed itself' : 'the only thing that can restore service in the baseline'} |`],
    [t1, `| ${rel(t1)} | workload ends | ${m.requests.total} requests issued |`],
  ];
  for (const h of m.mechanisms.healthTransitions) {
    rows.push([h.ts, `| ${rel(h.ts)} | health probe | ${String(h.target).replace('http://', '')} -> ${h.ok ? 'healthy' : 'UNHEALTHY'} |`]);
  }
  const firstFail = m.reliability.outages[0];
  if (firstFail) {
    rows.push([firstFail.startTs, `| ${rel(firstFail.startTs)} | first failed request | client-visible outage begins |`]);
    if (firstFail.endTs) {
      rows.push([firstFail.endTs, `| ${rel(firstFail.endTs)} | first success after outage | outage ends after ${(firstFail.durationMs / 1000).toFixed(1)} s |`]);
    }
  }
  const timeline = rows.sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('\n');

  return `# ${sc.title} -- ${mode.toUpperCase()}

Run window: ${iso(t0)} to ${iso(t1)} (${((t1 - t0) / 1000).toFixed(0)} s observation)
Version under test: \`FT_ENABLED=${mode === 'ft' ? 1 : 0}\`

## What was done to the system

${sc.injection}

**Expected behaviour of the fault-tolerance mechanisms:** ${sc.expectation}

## Timeline

| Offset | Event | Detail |
|---|---|---|
${timeline}

## Measured results

| Metric | Value |
|---|---|
| Total requests | ${m.requests.total} |
| Successful | ${m.requests.successful} |
| **Failed** | **${m.requests.failed}** |
| Served degraded (HTTP 203, stale data) | ${m.requests.degraded} |
| Client timeouts (10 s patience exceeded) | ${m.requests.clientTimeouts} |
| Availability, request-based | ${pctStr(m.availability.requestBased)} |
| Availability, time-based | ${pctStr(m.availability.timeBased)} |
| Observed failures (outages) | ${m.reliability.observedFailures} |
| MTTF | ${m.reliability.mttfCensored ? `> ${s1(m.observationMs)} (right-censored: no outage occurred)` : s1(m.reliability.mttfMs)} |
| MTBF | ${s1(m.reliability.mtbfMs)} ${m.reliability.mtbfMs != null ? `(${m.reliability.mtbfSource})` : ''} |
| MTTR | ${s1(m.reliability.mttrMs)} |
| Observed failure rate | ${m.reliability.failureRatePerHour.toFixed(1)} outages/hour |
| **Detection time** | ${ms(m.response.detectionMs)}${m.response.detectionSource !== 'none' ? ` (via ${m.response.detectionSource})` : ''} |
| Fault actively absorbed for | ${ms(m.response.absorptionMs)} (last internal failure after injection) |
| Fault masked from clients entirely | ${m.response.faultMasked ? 'yes -- detected and absorbed before any client saw a failure' : 'no'} |
| **Recovery time** (client-visible outage ends) | ${m.response.recoveryMs == null ? (m.response.faultMasked ? 'no client-visible outage occurred' : 'n/a') : ms(m.response.recoveryMs)} |
| Latency p50 / p95 / p99 / max | ${m.response.p50Ms} / ${m.response.p95Ms} / ${m.response.p99Ms} / ${m.response.maxMs} ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | ${m.mechanisms.failedCallAttempts} |
| Requests rescued by retry | ${m.mechanisms.retriesThatSucceeded} |
| Circuit breaker openings | ${m.mechanisms.breakerOpened} |
| Degraded (stale-data) responses | ${m.mechanisms.degradedResponses} |
| Reads failed over to the standby | ${m.mechanisms.replicaReads} |
| Duplicate payments suppressed | ${m.mechanisms.duplicatesSuppressed} |
| Orphaned checkpoints rolled back | ${m.mechanisms.checkpointsRolledBack} |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests sent | ${c.paymentRequestsSent} | of which ${c.paymentRequestsSent - c.distinctPaymentIntents} were client resends |
| Distinct payment intents | ${c.distinctPaymentIntents} | |
| Requests answered "already processed" (HTTP 200) | ${c.deduplicatedResponses} | ${c.deduplicatedResponses > 0 ? 'the idempotency key did its job' : 'no request was recognised as a duplicate'} |
| **Duplicate charges** | ${c.duplicateCharges} | ${c.duplicateCharges === 0 ? 'PASS -- no intent was charged more than once' : 'FAIL -- money taken twice for the same intent'} |
| Intents with no charge confirmed to the client | ${c.unacknowledgedIntents} | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | ${c.orphanedPending} | ${c.orphanedPending === 0 ? 'PASS -- no half-finished transaction left behind' : 'FAIL -- money neither charged nor released, with nothing to reconcile it'} |
| Checkpoints rolled back by recovery | ${c.rolledBack} | |
| Completed rows in the database | ${c.completedInDb} | ${c.dbVsIntents === 0 ? 'exactly one per intent' : `${c.dbVsIntents > 0 ? '+' : ''}${c.dbVsIntents} against the number of intents sent`} |
| Ledger balanced (payments = balances) | ${c.ledgerBalanced} | ${c.ledgerBalanced ? 'PASS' : 'FAIL'} |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* \`workload.jsonl\` -- one line per client request (${m.requests.total} lines)
* \`events.jsonl\` -- one line per service-side event in this window (${events.length} lines)
* \`metrics.json\` -- the computed metrics above, machine-readable

Metric definitions are in \`scripts/metrics.ts\`; every value here is derived from
the two raw files in this directory and can be recomputed from them.
`;
}

export function rebuildLog(): void {
  const dir = `${ROOT}results`;
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${dir}/${d.name}/metrics.json`))
    .map((d) => JSON.parse(readFileSync(`${dir}/${d.name}/metrics.json`, 'utf8')))
    .sort((a, b) => a.t0 - b.t0);

  const rows = runs.map((r, i) => {
    const m = r.metrics, c = r.consistency;
    const windowS = (r.t1 - r.t0) / 1000;
    return `| ${i + 1} | ${SCENARIOS[r.scenario].title} | ${r.mode} | ${m.requests.total} | ${m.requests.failed} | ` +
      `${pctStr(m.availability.requestBased)} | ${pctStr(m.availability.timeBased)} | ${ms(m.response.detectionMs)} | ` +
      `${m.response.recoveryMs == null ? '--' : ms(m.response.recoveryMs)} | ${s1(m.reliability.mttrMs)} | ` +
      `${c.duplicateCharges} | ${c.orphanedPending} | ${windowS.toFixed(1)} s | [report](${r.scenario}__${r.mode}/REPORT.md) |`;
  });

  writeFileSync(`${dir}/EXPERIMENT-LOG.md`, `# Experiment log

Every controlled run, in execution order. Each row links to a per-run report
containing the timeline, the raw data and the consistency checks. This file is
regenerated from the \`metrics.json\` of every run, so re-running a scenario
replaces its row instead of adding a second one.

The observation window is fixed at 70 s by the workload generator; the column is
shown so that any run whose window was distorted is visible rather than hidden.

| # | Scenario | Version | Requests | Failed | Avail. (req) | Avail. (time) | Detection | Recovery | MTTR | Dup. charges | Orphans | Window | Report |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}
`);
}
