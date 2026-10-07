import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { requireLoopback } from './local-development.mjs';
const root = resolve(import.meta.dirname, '..');
try {
  const configuration = readFileSync(join(root, '.local-dev/supabase/config.toml'), 'utf8');
  const project = configuration.match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1]; if (!project) throw new Error('Missing local project');
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('TEST_SUPABASE_') || key === 'TEST_LOCAL_DB_CONTAINER' || key.startsWith('SUPABASE_')) delete environment[key];
  const status = JSON.parse(execFileSync(join(root, 'node_modules/.bin/supabase'), ['--workdir', '.local-dev', 'status', '-o', 'json'], { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  requireLoopback(status.API_URL); if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Missing local credentials');
  Object.assign(environment, { TEST_SUPABASE_URL: status.API_URL, TEST_SUPABASE_ANON_KEY: status.ANON_KEY, TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, TEST_LOCAL_DB_CONTAINER: `supabase_db_${project}` });
  const suite = process.argv.includes('--public') ? 'tests/integration/public-menus.integration.test.ts' : 'tests/integration/restaurant-foundation.integration.test.ts';
  const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', suite, '--no-file-parallelism', '--maxWorkers=1', '--testTimeout=30000'], { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw new Error('Could not start tests'); process.exitCode = result.status ?? 1;
} catch { console.error('Restaurant integration requires this checkout’s running loopback stack. No skipped run was accepted as verification.'); process.exitCode = 1; }
