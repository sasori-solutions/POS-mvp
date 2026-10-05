import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { afterAll, describe, expect, it } from 'vitest'
import type { OperatorSession } from '../../src/lib/contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import { signedRequest } from './device-proof-fixture'

const url = process.env.TEST_SUPABASE_URL, enabled = Boolean(url)
if (enabled && (new URL(url!).protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))) throw new Error('Financial concurrency tests require loopback Auth/Edge/PostgreSQL')
const anon = process.env.TEST_SUPABASE_ANON_KEY ?? '', service = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? ''
const container = process.env.TEST_LOCAL_DB_CONTAINER ?? ''
const admin = enabled ? createClient(url!, service, { auth: { persistSession: false, autoRefreshToken: false } }) : null
const users: string[] = [], businesses: string[] = []
type Actor = { userId: string; authSessionId: string; jwt: string; operator: OperatorSession }
type Reply<T> = { status: number; data?: T; error?: { code: string } }

describe.skipIf(!enabled)('financial authorization serialized with real Auth session revocation', () => {
  afterAll(async () => {
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')})`)
    for (const id of users) { const result = await admin!.auth.admin.deleteUser(id); if (result.error) throw result.error }
  }, 60_000)

  it('finishes one accepted collection before logout completes and rejects its later replay', async () => {
    const { actor, quote } = await fixture(), command = payment(quote)
    const mutex = session(), revoker = session()
    let accepted: Promise<Reply<{ order: OperationalOrder; attempt: CheckoutAttempt }>> | undefined
    try {
      const mutexPid = await mutex.ready(`begin; select pg_advisory_xact_lock(hashtextextended('operations:'||${uuid(actor.operator.business.id)}::text,0))`)
      accepted = pos(actor, command); accepted.catch(() => {})
      await blockedBy(mutexPid)
      const revokePid = await revoker.ready('begin')
      revoker.process.stdin.write(`delete from auth.sessions where id=${uuid(actor.authSessionId)}; select 'REVOKED';\n`)
      // A share lock held by the accepted request forces logout to wait.
      await blockedPid(revokePid)
      expect(revoker.output()).not.toContain('REVOKED')
      await mutex.finish('commit')
      const paid = data(await accepted)
      expect(paid.order).toMatchObject({ paidCents: 1001, balanceCents: 0 })
      await revoker.until('REVOKED')
      await revoker.finish('commit')
      expect(await pos(actor, command)).toMatchObject({ status: 401, error: { code: 'AUTH_REQUIRED' } })
      expect(saleCount(actor)).toBe(1)
    } finally {
      await mutex.finish('rollback'); await revoker.finish('rollback')
      if (accepted) await accepted.catch(() => {})
    }
  }, 30_000)

  it.each(['logout', 'expired-session'] as const)('rejects collection if %s owns the Auth row before authorization', async kind => {
    const { actor, quote } = await fixture(), command = payment(quote), revoker = session()
    let denied: Promise<Reply<unknown>> | undefined
    try {
      const mutation = kind === 'logout' ? `delete from auth.sessions where id=${uuid(actor.authSessionId)}`
        : `update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=${uuid(actor.authSessionId)}`
      const pid = await revoker.ready(`begin; ${mutation}`)
      denied = pos(actor, command); denied.catch(() => {})
      await blockedBy(pid)
      await revoker.finish('commit')
      expect(await denied).toMatchObject({ status: 401, error: { code: 'AUTH_REQUIRED' } })
      expect(saleCount(actor)).toBe(0)
      expect(sql(`select status from app_private.checkout_attempts where business_id=${uuid(actor.operator.business.id)} and id=${uuid(quote.id)}`).trim()).toBe('prepared')
      expect(Number(sql(`select sum(paid_quantity) from app_private.order_lines where business_id=${uuid(actor.operator.business.id)}`))).toBe(0)
    } finally {
      await revoker.finish('rollback')
      if (denied) await denied.catch(() => {})
    }
  }, 30_000)
})

async function fixture() {
  if (!container) throw new Error('Missing checkout-local Postgres container')
  const email = `financial-auth-${randomUUID()}@example.test`, password = `Local-${randomUUID()}-Aa9!`
  const created = await admin!.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error
  users.push(created.data.user.id)
  const auth = createClient(url!, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const signed = await auth.auth.signInWithPassword({ email, password }); if (signed.error || !signed.data.session) throw signed.error ?? new Error('Missing synthetic session')
  const jwt = signed.data.session.access_token
  const authSessionId = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).session_id as string
  const actor = { userId: created.data.user.id, authSessionId, jwt } as Actor
  actor.operator = data(await call<OperatorSession>(actor, { action: 'create_business', operationId: randomUUID(), name: 'Financial Auth concurrency synthetic', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '583927', profile: { branchName: 'Local', registerName: 'Caja', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }))
  businesses.push(actor.operator.business.id)
  data(await pos(actor, { command: 'activate_operations', operationId: randomUUID() }))
  data(await pos(actor, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }))
  const product = data(await pos<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents: 1001 }))
  const order = data(await pos<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, quantity: 1, unitPriceCents: product.priceCents, note: '' }] }))
  const quote = data(await pos<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: order.items.map(item => ({ lineId: item.lineId, quantity: 1 })), paymentMethod: 'cash' }))
  return { actor, quote }
}
function payment(quote: CheckoutAttempt) { return { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const } }
async function call<T>(actor: Actor, payload: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${actor.jwt}` }, body: JSON.stringify(await signedRequest(actor.userId, payload)), signal: AbortSignal.timeout(20_000) })
  return { status: response.status, ...await response.json() }
}
async function pos<T = unknown>(actor: Actor, command: PosCommand) {
  const reply = await call<T>(actor, { action: 'pos', businessId: actor.operator.business.id, operatorToken: actor.operator.operatorToken, ...command })
  if (reply.status === 200) assertFinancialResponse(command, reply.data)
  return reply
}
function data<T>(reply: Reply<T>): T { expect(reply.error).toBeUndefined(); expect(reply.status).toBe(200); expect(reply.data).toBeDefined(); return reply.data! }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID'); return `'${value}'::uuid` }
function sql(statement: string) { return execFileSync('docker', psqlArgs(), { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() }
function psqlArgs() { return ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'] }
function saleCount(actor: Actor) { return Number(sql(`select count(*) from app_private.sales where business_id=${uuid(actor.operator.business.id)}`)) }
async function blockedBy(pid: number) {
  for (let n = 0; n < 100; n++) { if (Number(sql(`select count(*) from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`)) > 0) return; await delay(20) }
  throw new Error('Expected real PostgreSQL contention on the fixture lock')
}
async function blockedPid(pid: number) {
  for (let n = 0; n < 100; n++) { if (sql(`select wait_event_type='Lock' from pg_stat_activity where pid=${pid}`) === 't') return; await delay(20) }
  throw new Error('Auth revocation did not wait on the accepted request')
}
function session() {
  const process: ChildProcessWithoutNullStreams = spawn('docker', psqlArgs(), { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = '', finished = false
  process.stdout.on('data', value => { output += String(value) }); process.stderr.on('data', value => { errors += String(value) })
  const done = new Promise<void>((resolve, reject) => { process.on('error', reject); process.on('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic lock session failed: ${errors}`))) })
  async function until(marker: string) {
    for (let n = 0; n < 150; n++) { if (output.includes(marker)) return; await delay(20) }
    throw new Error('Synthetic lock session did not become ready')
  }
  return { process, output: () => output, until,
    async ready(statement: string) {
      const marker = `READY_${randomUUID()}`
      process.stdin.write(`${statement}; select '${marker}:'||pg_backend_pid();\n`)
      await until(marker)
      const pid = Number(output.split(marker + ':')[1]?.split('\n')[0]); if (!Number.isSafeInteger(pid)) throw new Error('Missing lock session PID')
      return pid
    },
    async finish(statement: string) { if (finished) return; finished = true; process.stdin.end(`${statement};\n`); await done },
  }
}
