import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// An explicit disposable marker prevents an accidental reset of routine dev data.
if (process.env.TEST_DISPOSABLE_SUPABASE !== 'true') throw new Error('Reset requires TEST_DISPOSABLE_SUPABASE=true')
if (existsSync('supabase/.temp/project-ref')) throw new Error('Reset refuses a linked checkout')
const marker = '.local-test-disposable'
const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
if (!project || !existsSync(marker) || readFileSync(marker,'utf8').trim() !== project) throw new Error('Create .local-test-disposable containing the exact disposable project_id first')
const executable = resolve(`node_modules/.bin/supabase${process.platform === 'win32' ? '.cmd' : ''}`)
const status = JSON.parse(execFileSync(executable,['status','-o','json'], { encoding:'utf8', stdio:['ignore','pipe','pipe'], shell:process.platform==='win32' }))
for (const name of ['API_URL','DB_URL']) {
  if (!status[name] || !['localhost','127.0.0.1','[::1]'].includes(new URL(status[name]).hostname)) throw new Error('Reset refuses non-loopback services')
}
execFileSync(executable,['db','reset','--local'], { stdio:'inherit', shell:process.platform==='win32' })
