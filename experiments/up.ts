import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ENV: Record<string, string> = {
  ft: 'FT_ENABLED=1\nRESTART_POLICY=unless-stopped\n',
  baseline: 'FT_ENABLED=0\nRESTART_POLICY=no\n',
};

const env = ENV[process.argv[2]];
if (!env) {
  console.log('usage: npm run up:ft | npm run up:baseline');
  process.exit(1);
}
writeFileSync(new URL('../.env', import.meta.url), env);  // compose reads the mode from .env
const r = spawnSync('docker', ['compose', 'up', '-d', '--build'], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
process.exit(r.status ?? 1);
