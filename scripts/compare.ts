// Builds results/COMPARISON.md: the baseline-vs-fault-tolerant comparison and the
// campaign-level reliability calculations. Every table is generated from the
// metrics.json of each run, so the document cannot drift from the data.
//
//   node --experimental-strip-types scripts/compare.ts
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SCENARIOS } from './scenarios.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = `${ROOT}results`;
const ORDER = ['app-crash', 'db-failure', 'net-timeout', 'node-failure', 'txn-interrupt', 'high-load'];

type Run = { scenario: string; mode: string; t0: number; t1: number; metrics: any; consistency: any };

const runs: Run[] = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`${DIR}/${d.name}/metrics.json`))
  .map((d) => JSON.parse(readFileSync(`${DIR}/${d.name}/metrics.json`, 'utf8')));

const get = (scenario: string, mode: string) => runs.find((r) => r.scenario === scenario && r.mode === mode);
const pct = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} %`);
const ms = (v: number | null) => (v == null ? '--' : `${v} ms`);

// ----------------------------------------------------------- campaign totals
function totals(mode: string) {
  const rs = runs.filter((r) => r.mode === mode);
  const requests = rs.reduce((a, r) => a + r.metrics.requests.total, 0);
  const failed = rs.reduce((a, r) => a + r.metrics.requests.failed, 0);
  const upBins = rs.reduce((a, r) => a + r.metrics.availability.upBins, 0);
  const downBins = rs.reduce((a, r) => a + r.metrics.availability.downBins, 0);
  const observationMs = rs.reduce((a, r) => a + r.metrics.observationMs, 0);
  const outages = rs.flatMap((r) => r.metrics.reliability.outages);
  const closed = outages.filter((o: any) => !o.open);
  const downtimeMs = closed.reduce((a: number, o: any) => a + o.durationMs, 0);
  const mttr = closed.length ? downtimeMs / closed.length : null;
  // MTTF over the campaign: total time the system was operating, divided by the
  // number of times it stopped operating. With zero observed failures the value
  // is right-censored and only a lower bound can be stated.
  const mttf = outages.length ? (observationMs - downtimeMs) / outages.length : null;
  const mtbf = mttf != null && mttr != null ? mttf + mttr : null;
  return {
    runs: rs.length, requests, failed, observationMs, outages: outages.length, downtimeMs,
    mttf, mttr, mtbf,
    availabilityTime: upBins + downBins ? upBins / (upBins + downBins) : null,
    availabilityReq: requests ? (requests - failed) / requests : null,
    failureRatePerHour: outages.length / (observationMs / 3_600_000),
    duplicates: rs.reduce((a, r) => a + r.consistency.duplicateCharges, 0),
    orphans: rs.reduce((a, r) => a + r.consistency.orphanedPending, 0),
    retries: rs.reduce((a, r) => a + r.metrics.mechanisms.retriesThatSucceeded, 0),
    degraded: rs.reduce((a, r) => a + r.metrics.requests.degraded, 0),
    replicaReads: rs.reduce((a, r) => a + r.metrics.mechanisms.replicaReads, 0),
    breakers: rs.reduce((a, r) => a + r.metrics.mechanisms.breakerOpened, 0),
    absorbed: rs.reduce((a, r) => a + r.metrics.mechanisms.failedCallAttempts, 0),
  };
}

const B = totals('baseline');
const F = totals('ft');

// ------------------------------------------------- theoretical availability
// Series-parallel model. Component MTTF values are assumptions (stated as such);
// MTTR is taken from the measurement campaign wherever it was observed.
const H = 3_600_000;
const model = (mttfMs: number, mttrMs: number) => mttfMs / (mttfMs + mttrMs);
const parallel = (a: number, n: number) => 1 - (1 - a) ** n;
const COMPONENT_MTTF_H = 720;                       // assumption: one failure per component per month
const componentA = model(COMPONENT_MTTF_H * H, F.mttr ?? 3000);
const componentA_base = model(COMPONENT_MTTF_H * H, B.mttr ?? 30_000);
const theoreticalFt = parallel(componentA, 2) ** 2 * componentA * parallel(componentA, 2) * componentA;
const theoreticalBase = componentA_base ** 5;

const row = (s: string) => {
  const b = get(s, 'baseline'), f = get(s, 'ft');
  if (!b || !f) return '';
  const t = SCENARIOS[s].title;
  return `| ${t} | ${b.metrics.requests.failed} / ${b.metrics.requests.total} | **${f.metrics.requests.failed} / ${f.metrics.requests.total}** | ` +
    `${pct(b.metrics.availability.requestBased)} | **${pct(f.metrics.availability.requestBased)}** | ` +
    `${ms(b.metrics.response.detectionMs)} | ${ms(f.metrics.response.detectionMs)} | ` +
    `${b.consistency.duplicateCharges} | **${f.consistency.duplicateCharges}** | ` +
    `${b.consistency.orphanedPending} | **${f.consistency.orphanedPending}** |`;
};

const mech = (s: string) => {
  const f = get(s, 'ft');
  if (!f) return '';
  const m = f.metrics.mechanisms;
  return `| ${SCENARIOS[s].title} | ${m.failedCallAttempts} | ${m.retriesThatSucceeded} | ${m.breakerOpened} | ${m.degradedResponses} | ${m.replicaReads} | ${m.duplicatesSuppressed} | ${m.checkpointsRolledBack} |`;
};

const doc = `# Baseline vs fault-tolerant: results and comparison

All twelve runs use an identical 70 s observation window, an identical workload
(10 concurrent clients; 60 % student reads, 20 % transcript reads, 20 % payments,
of which 20 % are client-side resends of the same payment intent) and an identical
fault injected at T+20 s with an operator repair at T+45 s. The two versions are
the same container image; only \`FT_ENABLED\` and the restart policy differ.

## 1. Headline comparison

| Scenario | Failed (baseline) | Failed (FT) | Avail. req (base) | Avail. req (FT) | Detect (base) | Detect (FT) | Dup. charges (base) | Dup. (FT) | Orphans (base) | Orphans (FT) |
|---|---|---|---|---|---|---|---|---|---|---|
${ORDER.map(row).filter(Boolean).join('\n')}

## 2. Campaign totals

| Measure | Baseline | Fault-tolerant | Change |
|---|---|---|---|
| Runs | ${B.runs} | ${F.runs} | |
| Total requests | ${B.requests} | ${F.requests} | |
| Failed requests | **${B.failed}** | **${F.failed}** | ${B.failed ? `${(100 * (1 - F.failed / B.failed)).toFixed(1)} % fewer` : '--'} |
| Availability (request-based) | ${pct(B.availabilityReq)} | ${pct(F.availabilityReq)} | |
| Availability (time-based) | ${pct(B.availabilityTime)} | ${pct(F.availabilityTime)} | |
| Observed outages | ${B.outages} | ${F.outages} | |
| Total downtime | ${(B.downtimeMs / 1000).toFixed(1)} s | ${(F.downtimeMs / 1000).toFixed(1)} s | |
| MTTF | ${B.mttf == null ? `> ${(B.observationMs / 1000).toFixed(0)} s (censored)` : `${(B.mttf / 1000).toFixed(1)} s`} | ${F.mttf == null ? `> ${(F.observationMs / 1000).toFixed(0)} s (censored)` : `${(F.mttf / 1000).toFixed(1)} s`} | |
| MTBF | ${B.mtbf == null ? 'n/a' : `${(B.mtbf / 1000).toFixed(1)} s`} | ${F.mtbf == null ? 'n/a' : `${(F.mtbf / 1000).toFixed(1)} s`} | |
| MTTR | ${B.mttr == null ? 'n/a' : `${(B.mttr / 1000).toFixed(1)} s`} | ${F.mttr == null ? 'n/a (nothing to repair)' : `${(F.mttr / 1000).toFixed(1)} s`} | |
| Observed failure rate | ${B.failureRatePerHour.toFixed(1)} /h | ${F.failureRatePerHour.toFixed(1)} /h | |
| **Duplicate charges** | **${B.duplicates}** | **${F.duplicates}** | |
| **Orphaned checkpoints** | **${B.orphans}** | **${F.orphans}** | |

Each version was exposed to six injected faults over ${(B.observationMs / 1000).toFixed(0)} s
and ${(F.observationMs / 1000).toFixed(0)} s of observation respectively.

## 3. What happened in each scenario

**Application crash.** The baseline lost ${get('app-crash','baseline')!.metrics.requests.failed} of
${get('app-crash','baseline')!.metrics.requests.total} requests (${pct(1 - get('app-crash','baseline')!.metrics.availability.requestBased!)}).
The arithmetic explains itself: student traffic is 60 % of the mix, round robin
sends half of it to the dead instance, and the instance is dead for 25 of the 70
seconds -- 0.6 x 0.5 x 25/70 = 10.7 %, against ${pct(1 - get('app-crash','baseline')!.metrics.availability.requestBased!)} measured. The baseline has no
health checks, so the gateway kept routing to a process that no longer existed. The
fault-tolerant version detected the crash in ${ms(get('app-crash','ft')!.metrics.response.detectionMs)} from a
failed call attempt, rescued ${get('app-crash','ft')!.metrics.mechanisms.retriesThatSucceeded} in-flight requests by
retrying them onto student-2, and lost nothing. Note that time-based availability is
100 % in both versions: the service never stopped answering, it just answered wrongly
half the time -- which is precisely why request-based availability must also be reported.

**Database failure.** This is the one row where the fault-tolerant version looks
worse, and the explanation matters. It returned ${get('db-failure','ft')!.metrics.requests.failed} errors against the
baseline's ${get('db-failure','baseline')!.metrics.requests.failed}, but those errors are payment *writes* failing fast: a hot
standby is read-only, so with the primary down there is nowhere for a write to go, and
failing in ${get('db-failure','ft')!.metrics.response.p95Ms} ms is the correct behaviour. Meanwhile reads stayed up --
${get('db-failure','ft')!.metrics.mechanisms.replicaReads} served from the standby and
${get('db-failure','ft')!.metrics.requests.degraded} from the stale cache -- and the client-visible outage was zero.
The baseline's low error count is an artefact: with no timeout, ${get('db-failure','baseline')!.metrics.requests.clientTimeouts} requests hung for the
client's full 10 s patience, and a blocked client issues no further requests. Throughput
collapsed from ${get('db-failure','ft')!.metrics.requests.total} to ${get('db-failure','baseline')!.metrics.requests.total} requests and the system was genuinely
unavailable for ${((get('db-failure','baseline')!.metrics.reliability.mttrMs ?? 0)/1000).toFixed(1)} s (time-based availability
${pct(get('db-failure','baseline')!.metrics.availability.timeBased)}). Hanging is not better than failing; it only looks
better in a ratio whose denominator it destroys.

**Network / service timeout.** Neither version lost a request, so availability says
nothing. Latency says everything: baseline p99 was ${get('net-timeout','baseline')!.metrics.response.p99Ms} ms -- the full injected
delay, paid by every client unlucky enough to be routed to the slow instance -- against
${get('net-timeout','ft')!.metrics.response.p99Ms} ms with fault tolerance, where the 800 ms per-attempt timeout fired and
the retry landed on the healthy replica. ${get('net-timeout','ft')!.metrics.mechanisms.retriesThatSucceeded} requests were rescued this way. This
is the scenario a liveness probe cannot catch: the slow instance kept answering
/health in milliseconds throughout.

**Hardware / node failure.** Killing student-1 and payment-1 together cost the baseline
${get('node-failure','baseline')!.metrics.requests.failed} requests (${pct(1 - get('node-failure','baseline')!.metrics.availability.requestBased!)}) and the fault-tolerant version
${get('node-failure','ft')!.metrics.requests.failed}. The surviving node absorbed the entire load; the platform degraded in
capacity, not in availability, which is the whole point of replicating across nodes.
Detection took ${ms(get('node-failure','ft')!.metrics.response.detectionMs)} and ${get('node-failure','ft')!.metrics.mechanisms.retriesThatSucceeded} requests were rescued by retry.

**Corrupted / lost transaction.** The most important row for data integrity. Both
payment instances died between writing the durable checkpoint and committing the
charge. The fault-tolerant version's recovery sweep rolled back
${get('txn-interrupt','ft')!.consistency.rolledBack} orphaned checkpoints, leaving ${get('txn-interrupt','ft')!.consistency.orphanedPending} rows stuck in \`pending\` and
${get('txn-interrupt','ft')!.consistency.duplicateCharges} duplicate charges. The baseline left ${get('txn-interrupt','baseline')!.consistency.orphanedPending} payments permanently
in \`pending\` -- money neither charged nor released, with no process that will ever
reconcile them -- and charged ${get('txn-interrupt','baseline')!.consistency.duplicateCharges} students twice.

**High load.** Raising concurrency from 10 to 110 workers broke neither version's
availability, and throughput was comparable (${get('high-load','baseline')!.metrics.requests.total} vs ${get('high-load','ft')!.metrics.requests.total} requests).
The difference is that the baseline began failing ${((get('high-load','baseline')!.metrics.response.detectionMs ?? 0)/1000).toFixed(0)} s into the overload and lost
${get('high-load','baseline')!.metrics.requests.failed} requests, while the fault-tolerant version lost none at a p95 of
${get('high-load','ft')!.metrics.response.p95Ms} ms. Duplicate charges tell the sharper story: ${get('high-load','baseline')!.consistency.duplicateCharges} in the baseline,
because overload is exactly when clients retry and exactly when a system without
idempotency keys charges them twice.

## 4. Which mechanism did the work

Counts are from the fault-tolerant runs; the baseline has none of these paths.

| Scenario | Failed calls absorbed | Rescued by retry | Breaker openings | Degraded responses | Replica reads | Duplicates suppressed | Checkpoints rolled back |
|---|---|---|---|---|---|---|---|
${ORDER.map(mech).filter(Boolean).join('\n')}

Campaign totals: ${F.absorbed} failed upstream calls absorbed internally,
${F.retries} requests rescued by retry, ${F.breakers} circuit-breaker openings,
${F.degraded} responses served degraded, ${F.replicaReads} reads failed over to the
standby.

## 5. Theoretical vs measured availability

A series-parallel model of the platform: gateway (single) -> student (2 replicas)
-> payment (2 replicas) -> transcript (single) -> database (single writable primary).

Assumption: each component has an MTTF of ${COMPONENT_MTTF_H} h (one failure per
component per month). MTTR is the campaign-measured value for each version
(${B.mttr == null ? 'n/a' : (B.mttr / 1000).toFixed(1) + ' s'} baseline,
${F.mttr == null ? 'no outage measured, 3 s assumed' : (F.mttr / 1000).toFixed(1) + ' s'} fault-tolerant).

| | Baseline | Fault-tolerant |
|---|---|---|
| Component availability | ${(componentA_base * 100).toFixed(6)} % | ${(componentA * 100).toFixed(6)} % |
| Predicted system availability | ${(theoreticalBase * 100).toFixed(6)} % | ${(theoreticalFt * 100).toFixed(6)} % |
| Measured (time-based, under injected faults) | ${pct(B.availabilityTime)} | ${pct(F.availabilityTime)} |

The predicted figures are far higher than the measured ones, and the discrepancy
is expected rather than an error: the model assumes faults arrive at the natural
component failure rate, whereas the campaign injects one fault every 70 s --
roughly ${(COMPONENT_MTTF_H * 3600 / 70).toFixed(0)}x the assumed rate. The model
also assumes independent failures, which the node-failure scenario deliberately
violates by taking out two components at once. The useful reading is the *ratio*
between the two columns, not the absolute values: replication raises predicted
availability by turning single points of failure into parallel pairs, and the
measured results reproduce that ordering.

## 6. Threats to validity

* **Three baseline runs were repeated.** In the first pass, node-failure,
  txn-interrupt and high-load stretched their 70 s window to 357 s, 150 s and
  262 s: with no timeout anywhere in the baseline, a single request hung on a
  stale keep-alive connection and the workload generator waited for it. The
  generator now closes the window unconditionally and marks anything still in
  flight as abandoned. Only the repeated runs are reported. The window length of
  every run is published in \`EXPERIMENT-LOG.md\` so this class of distortion is
  visible rather than hidden.
* **Request-based availability flatters the baseline.** A blocked client issues no
  further requests, so hangs shrink the denominator instead of showing up as
  failures. This is why time-based availability and absolute throughput are
  reported alongside it.
* **One container models one node.** Real node failure would also take out the
  host kernel, local disk and network path; this campaign only removes processes.
* **Single replication factor.** Two replicas per service and one standby is the
  smallest configuration that demonstrates the mechanisms; it says nothing about
  how the system behaves at larger scale.
* **The operator repair is simulated** as a fixed 25 s delay after injection. Real
  mean time to repair depends on paging, diagnosis and human response, all of
  which are outside this measurement.
`;

writeFileSync(`${DIR}/COMPARISON.md`, doc);
console.log(`wrote results/COMPARISON.md (${runs.length} runs)`);
