import type { Rec } from './workload.ts';

export type Event = Record<string, any>;

const pct = (xs: number[], p: number): number =>
  xs.length === 0 ? 0 : xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export type Outage = { startTs: number; endTs: number | null; durationMs: number; open: boolean };

export function outages(recs: Rec[], t0: number, t1: number): { outages: Outage[]; upBins: number; downBins: number; idleBins: number } {
  const bins = new Map<number, { total: number; ok: number }>();
  for (const r of recs) {
    const b = Math.floor((r.ts - t0) / 1000);  // 1 s bins; a bin with no success = down
    const cur = bins.get(b) ?? { total: 0, ok: 0 };
    cur.total++;
    if (r.ok) cur.ok++;
    bins.set(b, cur);
  }

  const n = Math.ceil((t1 - t0) / 1000);
  const state: ('up' | 'down' | 'idle')[] = [];
  for (let b = 0; b < n; b++) {
    const v = bins.get(b);
    state.push(!v || v.total === 0 ? 'idle' : v.ok > 0 ? 'up' : 'down');
  }

  const out: Outage[] = [];
  let runStart: number | null = null;
  for (let b = 0; b <= n; b++) {
    const s = b < n ? state[b] : 'up';
    if (s === 'down' && runStart === null) runStart = b;
    if (s === 'up' && runStart !== null) {
      const startTs = recs.find((r) => !r.ok && r.ts >= t0 + runStart! * 1000)?.ts ?? t0 + runStart * 1000;
      const endTs = recs.find((r) => r.ok && r.ts >= t0 + b * 1000)?.ts ?? t0 + b * 1000;
      out.push({ startTs, endTs, durationMs: endTs - startTs, open: false });
      runStart = null;
    }
  }
  if (runStart !== null) {
    const startTs = recs.find((r) => !r.ok && r.ts >= t0 + runStart! * 1000)?.ts ?? t0 + runStart * 1000;
    out.push({ startTs, endTs: null, durationMs: t1 - startTs, open: true });
  }

  return {
    outages: out,
    upBins: state.filter((s) => s === 'up').length,
    downBins: state.filter((s) => s === 'down').length,
    idleBins: state.filter((s) => s === 'idle').length,
  };
}

export function computeMetrics(recs: Rec[], events: Event[], t0: number, t1: number, injectTs: number) {
  const observationMs = t1 - t0;
  const { outages: outs, upBins, downBins, idleBins } = outages(recs, t0, t1);

  const ttfs: number[] = [];
  let cursor = t0;
  for (const o of outs) {
    ttfs.push(o.startTs - cursor);
    if (o.endTs) cursor = o.endTs;
  }

  const mttr = mean(outs.filter((o) => !o.open).map((o) => o.durationMs));  // MTTR: mean outage length
  const mttf = mean(ttfs);  // MTTF: mean uptime before an outage
  const onsets = outs.map((o) => o.startTs);
  const mtbfDirect = onsets.length >= 2 ? mean(onsets.slice(1).map((t, i) => t - onsets[i])) : null;
  const mtbf = mtbfDirect ?? (mttf != null && mttr != null ? mttf + mttr : null);  // MTBF = MTTF + MTTR

  const firstFailAfter = recs.find((r) => !r.ok && r.ts >= injectTs)?.ts ?? null;
  const firstHealthAfter = events.find((e) => e.kind === 'health' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const firstAttemptFail = events.find((e) => e.kind === 'attempt' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const firstUpstreamFail = events.find((e) => e.kind === 'upstream' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const detectionCandidates = [firstFailAfter, firstHealthAfter, firstAttemptFail, firstUpstreamFail]
    .filter((x): x is number => x != null);
  const detectionMs = detectionCandidates.length ? detectionCandidates.reduce((a, b) => (b < a ? b : a)) - injectTs : null;  // earliest evidence of the fault
  const outageAfterInject = outs.find((o) => o.startTs >= injectTs);
  const internalFailures = events.filter((e) => (e.kind === 'attempt' || e.kind === 'upstream') && e.ok === false && e.ts >= injectTs);
  const absorptionMs = internalFailures.length ? internalFailures[internalFailures.length - 1].ts - injectTs : null;
  const recoveryMs = outageAfterInject?.endTs != null ? outageAfterInject.endTs - injectTs : null;

  const ok = recs.filter((r) => r.ok);
  const latencies = ok.map((r) => r.ms);
  const count = (pred: (e: Event) => boolean) => events.filter(pred).length;

  return {
    observationMs,
    requests: {
      total: recs.length,
      successful: ok.length,
      failed: recs.length - ok.length,
      degraded: recs.filter((r) => r.degraded).length,
      clientTimeouts: recs.filter((r) => r.err === 'client_timeout').length,
    },
    availability: {
      timeBased: upBins + downBins === 0 ? null : upBins / (upBins + downBins),
      requestBased: recs.length === 0 ? null : ok.length / recs.length,
      upBins, downBins, idleBins,
    },
    reliability: {
      observedFailures: outs.length,
      mttfMs: mttf,
      mttfCensored: outs.length === 0,          // no failure observed: MTTF > observation window
      mtbfMs: mtbf,
      mtbfSource: mtbfDirect != null ? 'observed onset intervals' : 'MTTF + MTTR (fewer than two outages)',
      mttrMs: mttr,
      failureRatePerHour: outs.length / (observationMs / 3_600_000),
      outages: outs,
    },
    response: {
      detectionMs,
      recoveryMs,
      absorptionMs,
      faultMasked: detectionCandidates.length > 0 && firstFailAfter == null,
      detectionSource: firstAttemptFail != null && firstAttemptFail === detectionCandidates.reduce((a, b) => (b < a ? b : a)) ? 'failed call attempt'
        : firstHealthAfter != null && firstHealthAfter === detectionCandidates.reduce((a, b) => (b < a ? b : a)) ? 'failed health probe'
        : firstFailAfter != null ? 'client-visible failure' : 'none',
      p50Ms: pct(latencies, 50),
      p95Ms: pct(latencies, 95),
      p99Ms: pct(latencies, 99),
      maxMs: latencies.reduce((a, b) => (b > a ? b : a), 0),
    },
    mechanisms: {
      failedCallAttempts: count((e) => e.kind === 'attempt' && e.ok === false),
      retriesThatSucceeded: count((e) => e.kind === 'recovery' && e.action === 'retry_succeeded'),
      breakerOpened: count((e) => e.kind === 'breaker' && e.state === 'open'),
      degradedResponses: count((e) => e.kind === 'degraded'),
      replicaReads: count((e) => e.kind === 'degraded' && e.reason === 'read_from_replica'),
      duplicatesSuppressed: count((e) => e.kind === 'recovery' && e.action === 'duplicate_suppressed'),
      checkpointsRolledBack: count((e) => e.kind === 'recovery' && e.action === 'checkpoint_rolled_back'),
      healthTransitions: events.filter((e) => e.kind === 'health').map((e) => ({ ts: e.ts, target: e.target, ok: e.ok })),
    },
  };
}

export type Metrics = ReturnType<typeof computeMetrics>;

export type Ledger = {
  completed: number; pending: number; rolledBack: number; failedPay: number;
  charged: number; balances: number;
};

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
    dbVsIntents: ledger.completed - intents.size,
    orphanedPending: ledger.pending,
    rolledBack: ledger.rolledBack,
    failedPay: ledger.failedPay,
    totalCharged: ledger.charged,
    ledgerBalanced: ledger.charged === ledger.balances,
  };
}
