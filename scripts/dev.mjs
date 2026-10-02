import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { localConfiguration, requireLoopback, seedDevelopment } from './local-development.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = join(root, '.local-dev')
const cli = join(root, 'node_modules/.bin/supabase')
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const portArgument = args.find(arg => arg.startsWith('--port='))?.slice(7)
const port = Number(portIndex < 0 ? portArgument ?? 5173 : args[portIndex + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use --port with a valid local port.')
if (args.some(arg => arg === '--mode' || arg.startsWith('--mode=') || arg === '--host' || arg.startsWith('--host='))) {
  throw new Error('npm run dev always uses development mode on loopback. Use dev:frontend for explicit frontend configuration.')
}
const settings = localConfiguration(await readFile(join(root, 'supabase/config.toml'), 'utf8'), root, port)
const children = new Set()
const watchers = []
let stopping = false
let copyTimer
const cliEnvironment = { ...process.env }
for (const key of Object.keys(cliEnvironment)) {
  if (key.startsWith('SUPABASE_') || key.startsWith('VITE_') || key === 'ALLOW_TEST_PASSWORD_AUTH' || key === 'RESEND_API_KEY') delete cliEnvironment[key]
}

function redact(value) {
  return value.replace(/eyJ[A-Za-z0-9_.-]+/g, '[local JWT]').replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[local key]')
}
async function run(command, arguments_) {
  const child = spawn(command, arguments_, { cwd: root, env: cliEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => {
      children.delete(child)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command.endsWith('docker') ? 'Docker' : 'Local Supabase'} failed. ${redact(stderr).slice(-1600)}`))
    })
  })
}
const supabaseArgs = ['--workdir', directory]
function cleanup() {
  stopping = true
  clearTimeout(copyTimer)
  for (const watcher of watchers) watcher.close()
  for (const child of children) child.kill('SIGTERM')
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0) })

async function syncSource() {
  // Copies keep all relative shared-contract imports inside the CLI's mounted workdir.
  await cp(join(root, 'supabase/functions'), join(directory, 'supabase/functions'), { recursive: true, filter: path => !/\/\.env(?:\.|$)/.test(path) })
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true })
}

async function main() {
  if (args.includes('--stop')) {
    await run(cli, [...supabaseArgs, 'stop', '--project-id', settings.projectId])
    console.log('Stopped this checkout’s development backend; database volumes preserved.')
    return
  }
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop that frontend or choose npm run dev -- --port 5177.`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
  try { await run('docker', ['info', '--format', '{{.ServerVersion}}']) }
  catch { throw new Error('Start Docker Desktop, then retry npm run dev. A real local backend is required.') }
  await mkdir(join(directory, 'supabase'), { recursive: true })
  await writeFile(join(directory, 'supabase/config.toml'), settings.config)
  // Replace generated files only; database data lives in persistent Docker volumes.
  for (const path of ['supabase/migrations', 'supabase/functions', 'src']) await rm(join(directory, path), { recursive: true, force: true })
  await cp(join(root, 'supabase/migrations'), join(directory, 'supabase/migrations'), { recursive: true })
  await syncSource()
  const origin = `http://127.0.0.1:${port}`
  const functionEnv = join(directory, '.env.functions')
  await writeFile(functionEnv, `ALLOWED_ORIGINS=${origin},http://localhost:${port},http://127.0.0.1:5174,http://127.0.0.1:5175,http://127.0.0.1:5176\nALLOW_TEST_PASSWORD_AUTH=true\nAPP_ORIGIN=${origin}\nPIN_RECOVERY_FROM=POS local <access@pos.local.test>\nTEST_MAILPIT_URL=http://supabase_inbucket_${settings.projectId}:8025\n`, { mode: 0o600 })
  console.log(`Starting isolated Supabase ${settings.projectId}. First start may download Docker images…`)
  await run(cli, [...supabaseArgs, 'start', '-x', 'realtime,storage-api,imgproxy,postgres-meta,studio,logflare,vector,supavisor'])
  const status = JSON.parse(await run(cli, [...supabaseArgs, 'status', '-o', 'json']))
  requireLoopback(status.API_URL)
  if (status.API_URL !== settings.apiUrl) throw new Error('Local Supabase URL does not match this checkout’s isolated configuration.')
  console.log('Applying pending local migrations without resetting data…')
  await run(cli, [...supabaseArgs, 'migration', 'up', '--local'])
  const edge = spawn(cli, [...supabaseArgs, 'functions', 'serve', 'account', '--env-file', functionEnv], { cwd: root, env: cliEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(edge)
  edge.stderr.on('data', chunk => {
    for (const line of String(chunk).split('\n')) if (line && !line.includes('serving the request with supabase/functions/')) process.stderr.write(`${redact(line)}\n`)
  })
  edge.on('error', error => { console.error(error.message); cleanup(); process.exitCode = 1 })
  edge.on('exit', code => { if (!stopping) { console.error(`Local Edge stopped (${code}).`); cleanup(); process.exitCode = 1 } })
  let ready = false
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const response = await fetch(`${status.API_URL}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: status.ANON_KEY }, body: '{"action":"status"}', signal: AbortSignal.timeout(1000) })
      if (response.status === 401 && (await response.json()).error?.code === 'AUTH_REQUIRED') { ready = true; break }
    } catch { /* Wait for the local Edge worker to start. */ }
    await delay(250)
  }
  if (!ready) throw new Error('Local account function did not become ready.')
  const seeded = await seedDevelopment(status)
  console.log(seeded.created ? 'Created synthetic accounts, a café and three products.' : 'Preserved existing development accounts and business data.')
  console.log(`Local backend: ${status.API_URL}; mailbox: ${status.MAILPIT_URL ?? status.INBUCKET_URL}`)
  console.log('Development owner PIN: 123456 (initial fixture). Use /dev-login; no Google account required.')
  // Copy only changed backend/shared files; UI edits must not restart Edge.
  let copying = Promise.resolve()
  const changed = new Set()
  for (const relative of ['src/lib', 'supabase/functions']) {
    watchers.push(watch(join(root, relative), { recursive: true }, (_event, filename) => {
      if (!filename || /(^|\/)\.env(?:\.|$)/.test(filename)) return
      changed.add(join(relative, filename))
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        const paths = [...changed]; changed.clear()
        copying = copying.then(async () => {
          for (const path of paths) {
            try { await cp(join(root, path), join(directory, path), { recursive: true }) }
            catch (error) {
              if (error.code === 'ENOENT') await rm(join(directory, path), { recursive: true, force: true })
              else throw error
            }
          }
        }).catch(() => console.error('Could not refresh local Edge sources. Restart npm run dev.'))
      }, 100)
    }))
  }
  const frontendEnvironment = { ...cliEnvironment, NODE_ENV: 'development', VITE_SUPABASE_URL: status.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY, VITE_LOCAL_PASSWORD_AUTH: 'true' }
  const frontend = spawn(join(root, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--mode', 'development', ...args], { cwd: root, env: frontendEnvironment, stdio: 'inherit' })
  children.add(frontend)
  frontend.on('error', error => { console.error(error.message); cleanup(); process.exitCode = 1 })
  frontend.on('exit', code => { cleanup(); process.exitCode = code ?? 1 })
}

try { await main() }
catch (error) { console.error(error.message); cleanup(); process.exitCode = 1 }
