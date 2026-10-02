import { spawnSync } from 'node:child_process';
import { SCENARIOS } from './scenarios.ts';

for (const s of Object.keys(SCENARIOS)) {  // all six, against the deployed version
  const r = spawnSync(process.execPath, ['--experimental-strip-types', 'experiments/run.ts', s], {
    stdio: 'inherit',
    cwd: new URL('..', import.meta.url),
  });
  if (r.status !== 0) console.log(`!! ${s} failed, continuing`);
}
console.log('\ncampaign finished -- see reports/runs/');
