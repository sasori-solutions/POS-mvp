import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { requireLoopback } from './local-development.mjs'

// Read-only diagnostics against this checkout's local database. Prints counts,
// never credentials, identities, order contents or a purported balancing entry.
const root = resolve(import.meta.dirname, '..')
try {
  const configuration = readFileSync(join(root, '.local-dev/supabase/config.toml'), 'utf8')
  const project = configuration.match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1]
  if (!project) throw new Error('Missing local project')
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('SUPABASE_')) delete environment[key]
  const status = JSON.parse(execFileSync(join(root, 'node_modules/.bin/supabase'), ['--workdir', '.local-dev', 'status', '-o', 'json'], {
    cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  requireLoopback(status.API_URL)
  const query = `begin transaction isolation level repeatable read read only;
    select app_private.ops_financial_ledger_check() || app_private.ops_financial_adjustment_check();
    commit;`
  const result = JSON.parse(execFileSync('docker', ['exec', `supabase_db_${project}`, 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim())
  const checks = ['invalidQuotes', 'invalidSales', 'invalidCompletedAttempts', 'invalidReversals', 'invalidClosedShifts', 'invalidPendingSnapshots', 'invalidOrders', 'invalidCancellations', 'invalidWaivers']
  if (!checks.every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)) throw new Error('Unrecognized diagnostic contract')
  console.log(JSON.stringify({ environment: 'checkout-loopback', checks: result }, null, 2))
  if (Object.values(result).some(value => value !== 0)) {
    console.error('Financial inconsistencies require investigation. No data was changed.')
    process.exitCode = 1
  }
} catch {
  console.error('Ledger diagnostics require this checkout’s running local stack and current integrity migrations. No data was changed.')
  process.exitCode = 1
}
