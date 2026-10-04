import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { requireLoopback } from './local-development.mjs'

// Only this checkout's stack and synthetic tenants. The simulator's persisted
// identities and the development business are preserved between runs.
const root = resolve(import.meta.dirname, '..')
try {
  const configuration = readFileSync(join(root, '.local-dev/supabase/config.toml'), 'utf8')
  const project = configuration.match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1]
  if (!project?.startsWith('pos-dev-')) throw new Error('Missing local project')
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('TEST_') || key.startsWith('SUPABASE_')) delete environment[key]
  }
  const status = JSON.parse(execFileSync(join(root, 'node_modules/.bin/supabase'), ['--workdir', '.local-dev', 'status', '-o', 'json'], {
    cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  requireLoopback(status.API_URL)
  const secrets = JSON.parse(readFileSync(join(root, '.local-dev/point-secrets.json'), 'utf8'))
  const functionEnv = readFileSync(join(root, '.local-dev/.env.functions'), 'utf8')
  const simulatorPort = functionEnv.match(/^MP_API_BASE_URL=http:\/\/host.docker.internal:(\d+)$/m)?.[1]
  const origin = functionEnv.match(/^APP_ORIGIN=(.+)$/m)?.[1]
  if (!simulatorPort || !origin || !status.ANON_KEY || !status.SERVICE_ROLE_KEY || !secrets.workerSecret || !secrets.tokenKey) throw new Error('Missing local configuration')
  requireLoopback(origin)
  Object.assign(environment, {
    TEST_SUPABASE_URL: status.API_URL,
    TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
    TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    TEST_LOCAL_DB_CONTAINER: `supabase_db_${project}`,
    TEST_POINT_SIMULATOR_URL: `http://127.0.0.1:${simulatorPort}`,
    TEST_DISPOSABLE_SUPABASE: 'true', // Authorizes cleanup only of this suite's newly created tenants.
    TEST_POINT_PERSISTENT: 'true', // Never reset this checkout's simulator.
    TEST_POINT_WORKER_SECRET: secrets.workerSecret,
    TEST_POINT_TOKEN_KEY: secrets.tokenKey,
    TEST_POINT_TOKEN_KEY_ID: 'local',
    TEST_APP_ORIGIN: origin,
  })
  const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', 'tests/integration/point.integration.test.ts',
    '--no-file-parallelism', '--maxWorkers=1', '--testTimeout=30000', '--hookTimeout=60000'], { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw new Error('Could not start tests')
  process.exitCode = result.status ?? 1
} catch {
  console.error('Point integration requires this checkout’s local stack. Start npm run dev -- --point-simulator --point-manual-worker, then retry. No verification was accepted.')
  process.exitCode = 1
}
