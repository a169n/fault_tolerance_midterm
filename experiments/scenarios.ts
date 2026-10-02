// The six required failure scenarios (assignment §6), each as an injection and a
// repair step. Both versions of the system get the identical injection at the
// identical offset, which is what makes the baseline/FT comparison valid.
//
// "Repair" models an operator noticing and fixing the fault. It is issued at a
// fixed offset in BOTH versions: in the fault-tolerant version the system has
// usually healed itself long before and the command is a no-op, so the
// difference in measured MTTR is exactly the value of the automatic mechanisms.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const dc = async (...args: string[]): Promise<void> => {
  await exec('docker', ['compose', ...args], { cwd: ROOT }).catch((e) => {
    console.error(`  ! docker compose ${args.join(' ')}: ${e.message.split('\n')[0]}`);
  });
};

const chaos = async (port: number, body: unknown): Promise<void> => {
  await fetch(`http://localhost:${port}/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
};

const crash = async (port: number): Promise<void> => {
  await fetch(`http://localhost:${port}/chaos/crash`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
};

export type Scenario = {
  name: string;
  title: string;
  /** What is physically done to the system, for the report. */
  injection: string;
  /** What the fault-tolerance mechanisms are supposed to do about it. */
  expectation: string;
  durationMs: number;
  injectAtMs: number;
  repairAtMs: number;
  inject: () => Promise<void>;
  repair: () => Promise<void>;
  rampAtMs?: number;
  rampConcurrency?: number;
};

const D = 70_000;
const INJECT = 20_000;
const REPAIR = 45_000;

export const SCENARIOS: Record<string, Scenario> = {
  'app-crash': {
    name: 'app-crash',
    title: 'Application crash',
    injection: 'student-1 kills its own process (exit 1) from inside the container, simulating an unhandled fatal error rather than an operator stop.',
    expectation: 'Health checks detect the dead instance within one poll interval, the gateway routes to student-2, the restart policy brings the instance back, and in-flight requests are saved by retry.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => crash(3011),
    repair: () => dc('start', 'student-1'),
  },

  'db-failure': {
    name: 'db-failure',
    title: 'Database failure',
    injection: 'The PostgreSQL primary is stopped. The hot standby stays up.',
    expectation: 'Reads fail over to the standby, the transcript service serves stale cached data flagged as degraded, writes fail fast instead of hanging, and the circuit breaker prevents a retry storm.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('stop', 'postgres-primary'),
    repair: () => dc('start', 'postgres-primary'),
  },

  'net-timeout': {
    name: 'net-timeout',
    title: 'Network / service timeout',
    injection: '3000 ms of artificial latency is injected into student-1 only. Its health endpoint stays fast, so the instance is alive-but-slow -- the case a liveness probe cannot catch.',
    expectation: 'The per-attempt timeout (800 ms) fires, the retry lands on student-2 via ring rotation, and the client sees a normal response time instead of a 3 s stall.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => chaos(3011, { latencyMs: 3000 }),
    repair: () => chaos(3011, { latencyMs: 0 }),
  },

  'node-failure': {
    name: 'node-failure',
    title: 'Hardware / node failure',
    injection: 'student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. A SIGKILL from the operator does not trip the restart policy, so the node stays down until it is repaired.',
    expectation: 'The surviving node (student-2, payment-2) absorbs the full load; the platform degrades in capacity, not in availability.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('kill', 'student-1', 'payment-1'),
    repair: () => dc('start', 'student-1', 'payment-1'),
  },

  'txn-interrupt': {
    name: 'txn-interrupt',
    title: 'Corrupted / lost transaction',
    injection: 'Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment.',
    expectation: 'The recovery sweep rolls the orphaned checkpoint back so no money is half-moved, and the idempotency key ensures the client retry does not become a second charge.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { await chaos(3021, { crashAfterCheckpoint: true }); await chaos(3022, { crashAfterCheckpoint: true }); },
    repair: () => dc('start', 'payment-1', 'payment-2'),
  },

  'high-load': {
    name: 'high-load',
    title: 'High load',
    injection: 'Concurrency is raised from 10 to 110 workers for the remainder of the run. No component is broken -- the system is simply asked for more than it was sized for.',
    expectation: 'Latency rises but the service keeps answering; timeouts and the circuit breaker shed load instead of letting queues grow without bound.',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => {},
    repair: async () => {},
    rampAtMs: INJECT,
    rampConcurrency: 100,
  },
};

// Manual use, e.g. for the live demonstration:  node scripts/scenarios.ts app-crash inject
if (process.argv[1]?.endsWith('scenarios.ts')) {
  const [, , name, step] = process.argv;
  const s = SCENARIOS[name];
  if (!s || !['inject', 'repair'].includes(step ?? '')) {
    console.log('usage: node scripts/scenarios.ts <' + Object.keys(SCENARIOS).join('|') + '> <inject|repair>');
    process.exit(1);
  }
  await (step === 'inject' ? s.inject() : s.repair());
  console.log(`${name}: ${step} done`);
}
