import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyDetails } from '../../src/lib/product-details'
import type { PointCheckout } from '../../src/lib/point-contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Product } from '../../src/lib/pos-contracts'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string }
describe('definitive partial-refund refusal is atomic and financially inert', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  beforeEach(async () => { await db.exec('delete from app_private.point_jobs') })
  afterAll(async () => { await db?.close() })
  it('rejects the request and finishes its lease together; releases capacity without rewriting money', async () => {
    const f = await fixture(), before = await financialRows(f.actor.businessId)
    await expect(point(f.actor, { ...f.request, operationId: randomUUID() })).rejects.toThrow('POINT_RESULT_UNCERTAIN')
    expect(await service('refund_declined', f.decline)).toEqual({ saved: true })
    expect(await financialRows(f.actor.businessId)).toEqual(before)
    expect(await point<PointCheckout>(f.actor, { command: 'status', checkoutId: f.checkout.id })).toMatchObject({ state: 'approved_verified', refundedCents: 0, refundRequests: [{ id: f.decline.refundId, status: 'rejected', remoteRefundId: null }] })
    expect((await db.query('select status,lease_token,lease_until,last_error from app_private.point_jobs where id=$1', [f.decline.jobId])).rows[0]).toEqual({ status: 'done', lease_token: null, lease_until: null, last_error: 'unsupported_partially_refunds' })
    const next = await point<PointCheckout>(f.actor, { ...f.request, operationId: randomUUID(), amountCents: 1001, merchandiseCents: 1001 })
    expect(next.refundRequests.map(request => request.status)).toEqual(['rejected', 'pending'])
    await expect(service('refund_declined', f.decline)).rejects.toThrow('POINT_LEASE_LOST')
    expect(await financialRows(f.actor.businessId)).toEqual(before)
  })
  it.each(['leaseToken', 'refundId', 'code', 'remoteOrderId', 'paymentId', 'refundAmountCents', 'idempotencyKey', 'amountCents', 'receiverId', 'environment', 'externalReference', 'verified', 'refunds', 'observedAt'] as const)('rejects mismatched %s without releasing the reservation', async field => {
    const f = await fixture()
    const value = field === 'leaseToken' || field === 'refundId' || field === 'idempotencyKey' ? randomUUID()
      : field === 'refundAmountCents' || field === 'amountCents' ? 201 : field === 'verified' ? false
      : field === 'refunds' ? [{ id: 'unexpected', amountCents: 200 }] : field === 'observedAt' ? '2000-01-01T00:00:00Z' : 'mismatched'
    await expect(service('refund_declined', { ...f.decline, [field]: value })).rejects.toThrow(field === 'leaseToken' || field === 'refundId' ? 'POINT_LEASE_LOST' : 'POINT_FACT_MISMATCH')
    expect((await point<PointCheckout>(f.actor, { command: 'status', checkoutId: f.checkout.id })).refundRequests[0].status).toBe('pending')
  })
  it.each(['expired-lease', 'known-locator', 'confirmed', 'external-refund', 'total'] as const)('preserves %s and its financial state', async scenario => {
    const f = await fixture(scenario === 'total' ? 1001 : 200)
    if (scenario === 'expired-lease') await db.query("update app_private.point_jobs set lease_until=now()-interval '1 second' where id=$1", [f.decline.jobId])
    if (scenario === 'known-locator' || scenario === 'confirmed') await service('record_remote_refund', { jobId: f.decline.jobId, leaseToken: f.decline.leaseToken, refundId: f.decline.refundId, remoteRefundId: 'REFKNOWN' })
    if (scenario === 'external-refund' || scenario === 'confirmed') await service('apply_order', { ...f.facts, state: 'partially_refunded', refunds: [{ id: scenario === 'confirmed' ? 'REFKNOWN' : 'REFEXTERNAL', amountCents: 200, confirmedAt: new Date().toISOString() }] })
    const before = await financialRows(f.actor.businessId)
    await expect(service('refund_declined', f.decline)).rejects.toThrow(scenario === 'expired-lease' ? 'POINT_LEASE_LOST' : 'POINT_FACT_MISMATCH')
    expect(await financialRows(f.actor.businessId)).toEqual(before)
    expect((await point<PointCheckout>(f.actor, { command: 'status', checkoutId: f.checkout.id })).refundRequests[0].status).not.toBe('rejected')
  })
  it('keeps internal implementations unavailable to browser roles and service-role direct calls', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.point_service_before_refund_decline(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
    for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.point_service(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
  })
})
async function service<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: T }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result
}
async function pos<T = unknown>(actor: Actor, command: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: { data: T } }>('select public.pos_execute($1,$2,$3,$4,$5::jsonb) result', [actor.userId, actor.sessionId, actor.businessId, actor.token, JSON.stringify(command)])).rows[0].result.data
}
async function point<T = unknown>(actor: Actor, command: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: { data: T } }>("select public.account_secure($1,$2,'point',$3::jsonb) result", [actor.userId, actor.sessionId, JSON.stringify({ action: 'point', businessId: actor.businessId, operatorToken: actor.token, ...command })])).rows[0].result.data
}
async function fixture(amountCents = 200) {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  await db.query("insert into app_private.businesses(id,name,business_type,timezone) values($1,'Comercio sintético','cafe','America/Mexico_City')", [actor.businessId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Dueño sintético','owner')", [actor.employeeId, actor.businessId, actor.userId])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [actor.businessId, actor.userId, actor.sessionId, actor.token])
  await pos(actor, { command: 'activate_operations', operationId: randomUUID() }); await pos(actor, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const connection = await service<{ id: string }>('connection_save', { businessId: actor.businessId, environment: 'live', receiverId: randomUUID(), tokensCiphertext: 'synthetic-encrypted-tokens', expiresAt: '2099-01-01T00:00:00Z' })
  const terminalId = `SYNTHETIC-${randomUUID()}`
  await service('terminal_save', { connectionId: connection.id, terminalId, storeId: 'STORE', posId: 'POS', mode: 'PDV', verified: true, physicallyConfirmed: true })
  await point(actor, { command: 'activate', enabled: true })
  const product = await pos<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: 'Bebidas', priceCents: 1001, details: emptyDetails() })
  const order = await pos<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, items: [{ lineId: randomUUID(), productId: product.id, quantity: 1, unitPriceCents: 1001, version: product.version, note: '' }] })
  const reserved = await pos<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'card_integrated' })
  const prepared = await point<PointCheckout>(actor, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: reserved.id, terminalId })
  const checkout = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: prepared.id })
  const attempt = (await db.query<{ receiver_id: string; external_reference: string }>('select receiver_id,external_reference from app_private.point_attempts where id=$1', [checkout.attemptId])).rows[0]
  const facts = { attemptId: checkout.attemptId, remoteOrderId: `ORD-${checkout.attemptId}`, paymentId: `PAY-${checkout.attemptId}`, amountCents: 1001, receiverId: attempt.receiver_id, environment: 'live', externalReference: attempt.external_reference, currency: 'MXN', observedAt: new Date().toISOString(), refunds: [], verified: true }
  await service('apply_order', { ...facts, state: 'approved_verified' })
  await db.query('delete from app_private.point_jobs where business_id=$1', [actor.businessId])
  const request = { command: 'refund', operationId: randomUUID(), checkoutId: checkout.id, amountCents, merchandiseCents: amountCents, tipCents: 0, reason: 'Reembolso sintético' }
  const pending = await point<PointCheckout>(actor, request)
  const claimed = await service<{ jobs: { id: string; leaseToken: string }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: true })
  const job = claimed.jobs[0]
  const decline = { ...facts, state: 'approved', jobId: job.id, leaseToken: job.leaseToken, refundId: pending.refundRequests[0].id, code: 'unsupported_partially_refunds', refundAmountCents: amountCents, idempotencyKey: request.operationId }
  return { actor, checkout, facts, request, decline }
}
async function financialRows(businessId: string) {
  const result: unknown[] = []
  for (const table of ['sales', 'sale_items', 'point_refunds', 'point_fee_ledger']) result.push((await db.query(`select * from app_private.${table} where business_id=$1 order by 1`, [businessId])).rows)
  result.push((await db.query('select amount_cents,refunded_cents,state,sale_state,payment_id from app_private.point_attempts where business_id=$1', [businessId])).rows)
  return result
}
