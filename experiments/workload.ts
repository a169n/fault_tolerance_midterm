// Workload generator. Drives a realistic request mix against the gateway and
// records the outcome of EVERY request, which is the raw material for the
// availability / failure-rate / MTTR calculations in scripts/metrics.ts.
//
// The client-side timeout matters: without it a worker blocked on a hung baseline
// dependency would simply stop issuing requests, and the baseline would look
// better than it is. 10s represents the patience of a real user.

export type Rec = {
  ts: number;        // request start, epoch ms
  op: string;        // students | transcripts | payments
  status: number;    // 0 = transport failure or client timeout
  ok: boolean;       // 2xx or 203 degraded
  degraded: boolean; // 203: served, but from stale data
  abandoned?: boolean; // still in flight when the observation window closed
  ms: number;
  err?: string;
  intent?: string;   // logical payment intent (idempotency key)
  retry?: boolean;   // a client-side resend of the same intent
};

export type WorkloadOpts = {
  gateway: string;
  durationMs: number;
  concurrency: number;
  rampAtMs?: number;      // high-load scenario: extra workers join at this offset
  rampConcurrency?: number;
  clientTimeoutMs?: number;
  runId: string;
};

const OPS = [
  { name: 'students', weight: 0.6 },
  { name: 'transcripts', weight: 0.2 },
  { name: 'payments', weight: 0.2 },
];

const pickOp = () => {
  let r = Math.random();
  for (const o of OPS) if ((r -= o.weight) <= 0) return o.name;
  return 'students';
};

export async function runWorkload(opts: WorkloadOpts): Promise<Rec[]> {
  const { gateway, durationMs, concurrency, runId } = opts;
  const clientTimeoutMs = opts.clientTimeoutMs ?? 10_000;
  const deadline = Date.now() + durationMs;
  const recs: Rec[] = [];
  let intentCounter = 0;

  // Hard stop for the observation window. The baseline has no timeout anywhere,
  // so a single hung upstream can block a worker far past the client timeout; on
  // three early runs that stretched a 70 s window to 262 s and invalidated the
  // metrics. This controller guarantees the window is exactly durationMs.
  const windowOver = new AbortController();
  const stopTimer = setTimeout(() => windowOver.abort(), durationMs);

  async function once(op: string, intent?: string, retry = false): Promise<void> {
    const started = Date.now();
    const student = `s${1 + Math.floor(Math.random() * 200)}`;
    let url = `${gateway}/api/students/${student}`;
    // Whichever comes first: the client's patience, or the end of the window.
    const signal = AbortSignal.any([AbortSignal.timeout(clientTimeoutMs), windowOver.signal]);
    let init: RequestInit = { signal };

    if (op === 'transcripts') url = `${gateway}/api/transcripts/${student}`;
    if (op === 'payments') {
      url = `${gateway}/api/payments`;
      init = {
        ...init,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': intent! },
        body: JSON.stringify({ studentId: student, amount: 100 }),
      };
    }

    try {
      const res = await fetch(url, init);
      // Drain the body so the connection is reusable and the timing is honest.
      await res.text();
      recs.push({
        ts: started, op, status: res.status, ok: res.status < 400,
        degraded: res.status === 203, ms: Date.now() - started, intent, retry,
      });
    } catch (e) {
      const abandoned = windowOver.signal.aborted && Date.now() - started < clientTimeoutMs;
      recs.push({
        ts: started, op, status: 0, ok: false, degraded: false, abandoned,
        ms: Date.now() - started,
        err: abandoned ? 'abandoned_at_window_close'
          : (e as Error).name === 'TimeoutError' ? 'client_timeout' : (e as Error).message,
        intent, retry,
      });
    }
  }

  async function worker(): Promise<void> {
    while (Date.now() < deadline && !windowOver.signal.aborted) {
      const op = pickOp();
      if (op === 'payments') {
        const intent = `${runId}-${intentCounter++}`;
        await once(op, intent, false);
        // 20% of clients resend the same intent (the classic "did my payment go
        // through?" retry). With idempotency this must not produce a second charge.
        if (Math.random() < 0.2) await once(op, intent, true);
      } else {
        await once(op);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const workers = Array.from({ length: concurrency }, worker);

  if (opts.rampAtMs != null && opts.rampConcurrency) {
    setTimeout(() => {
      for (let i = 0; i < opts.rampConcurrency!; i++) workers.push(worker());
    }, opts.rampAtMs).unref();
  }

  // Wait for the window to close, then give aborted requests a bounded grace
  // period to settle. The race is the backstop: nothing may extend the window.
  await new Promise((r) => setTimeout(r, durationMs + 500));
  await Promise.race([Promise.allSettled(workers), new Promise((r) => setTimeout(r, 3000))]);
  clearTimeout(stopTimer);
  return recs.filter((r) => r.ts < deadline).sort((a, b) => a.ts - b.ts);
}
