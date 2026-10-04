import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyDetails } from '../../src/lib/product-details'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Product } from '../../src/lib/pos-contracts'
import type { CommissionStatement, PointCheckout, PointReport, PointSettings } from '../../src/lib/point-contracts'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string }
describe('Point private ledger and server reservations (single PostgreSQL session)', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('keeps feature disabled, private tables protected, service grants bounded and admins empty', async () => {
    const actor = await newActor()
    expect(await point<PointSettings>(actor, { command: 'settings' })).toMatchObject({ enabled: false, connection: null, permissions: { admin: false } })
    await expect(point(actor, { command: 'admin_report', from: '2026-01-01', to: '2026-01-31' })).rejects.toThrow('POINT_ADMIN_DENIED')
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>(`select has_function_privilege($1,'public.point_service(text,jsonb)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(false)
      expect((await db.query<{ allowed: boolean }>(`select has_table_privilege($1,'app_private.point_attempts','SELECT') allowed`, [role])).rows[0].allowed).toBe(false)
    }
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.sasori_admins')).rows[0].n).toBe(0)
  })

  it('persists single exact attempt/payload/terminal lock and prevents every manual result path', async () => {
    const { actor, checkout, reservation } = await setup()
    const start = { command: 'start', operationId: randomUUID(), checkoutId: checkout.id }
    const first = await point<PointCheckout>(actor, start)
    expect(first).toMatchObject({ state: 'pending', saleState: 'pending', totalCents: 1001 })
    expect(await point(actor, start)).toEqual(first)
    expect((await point<PointCheckout>(actor, { ...start, operationId: randomUUID() })).attemptId).toBe(first.attemptId)
    await expect(point(actor, { ...start, operationId: start.operationId, checkoutId: randomUUID() })).rejects.toThrow('POINT_CHECKOUT_NOT_FOUND')
    for (const command of ['record_checkout', 'resolve_checkout', 'update_checkout', 'start_checkout']) await expect(pos(actor, { command, operationId: randomUUID(), attemptId: reservation.id, expectedRevision: reservation.revision, confirmed: true })).rejects.toThrow('POINT_RESULT_UNCERTAIN')
    const jobs = await service<{ jobs: { id: string; leaseToken: string; payload: { createPayload: { transactions: { payments: { amount: string }[] } }; idempotencyKey: string; firstSentAt: string } }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID() })
    expect(jobs.jobs).toHaveLength(1)
    expect(jobs.jobs[0].payload.createPayload.transactions.payments[0].amount).toBe('10.01')
    expect(jobs.jobs[0].payload.idempotencyKey).toBe(first.attemptId)
    expect(jobs.jobs[0].payload.firstSentAt).toBeTruthy()
    await expect(service('complete_job', { id: jobs.jobs[0].id, leaseToken: randomUUID() })).rejects.toThrow('POINT_LEASE_LOST')
  })

  it('holds uncertainty, validates receiver/amount/environment and materializes immutable sale once after actor revocation', async () => {
    const { actor, checkout, connectionId } = await setup()
    const first = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(first.attemptId!)
    await service('apply_order', { ...evidence, state: 'unknown_review', statusDetail: 'action_required' })
    expect((await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })).state).toBe('unknown_review')
    expect((await service<{ applied: boolean }>('apply_order', { ...evidence, state: 'approved_verified', amountCents: 1002 })).applied).toBe(false)
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.sales where business_id=$1', [actor.businessId])).rows[0].n).toBe(0)
    await db.query('update app_private.employees set active=false where id=$1', [actor.employeeId])
    await service('apply_order', { ...evidence, state: 'approved_verified' })
    await service('apply_order', { ...evidence, state: 'pending', observedAt: '2026-01-01T00:00:00Z' })
    const rows = await db.query<{ state: string; sale_state: string }>('select state,sale_state from app_private.point_attempts where id=$1', [first.attemptId])
    expect(rows.rows[0]).toEqual({ state: 'approved_verified', sale_state: 'materialized' })
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.sales where business_id=$1', [actor.businessId])).rows[0].n).toBe(1)
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.point_fee_ledger where business_id=$1', [actor.businessId])).rows[0].n).toBe(1)
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.point_terminal_reservations where connection_id=$1', [connectionId])).rows[0].n).toBe(0)
  })

  it('deduplicates refunds, keeps original sale, bounds pending reservations and does not rewind a refund', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'approved_verified' })
    const refund = { command: 'refund', operationId: randomUUID(), checkoutId: checkout.id, amountCents: 600, merchandiseCents: 600, tipCents: 0, reason: 'Devolución sintética' }
    await point(actor, refund)
    await point(actor, refund)
    await expect(point(actor, { ...refund, operationId: randomUUID() })).rejects.toThrow('POINT_REFUND_LIMIT')
    const confirmed = { ...evidence, state: 'partially_refunded', refunds: [{ id: 'synthetic-refund-1', amountCents: 600, confirmedAt: new Date().toISOString() }] }
    await service('apply_order', confirmed); await service('apply_order', confirmed)
    await service('apply_order', { ...evidence, state: 'approved_verified', observedAt: '2026-01-01T00:00:00Z' })
    expect(await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })).toMatchObject({ state: 'partially_refunded', refundedCents: 600, sale: { totalCents: 1001 } })
    await service('apply_order', { ...evidence, state: 'refunded', refunds: [...confirmed.refunds, { id: 'synthetic-refund-2', amountCents: 401, confirmedAt: new Date().toISOString() }] })
    expect((await db.query<{ n: string }>('select sum(exact_numerator)::text n from app_private.point_fee_ledger where business_id=$1', [actor.businessId])).rows[0].n).toBe('0')
  })

  it('closes reproducible exact monthly statements, late refund residuals and partial commission payments', async () => {
    const { actor, checkout } = await setup(167)
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'approved_verified', observedAt: '2026-05-01T12:00:00Z' })
    const statement = await point<CommissionStatement>(actor, { command: 'close_statement', operationId: randomUUID(), period: '2026-05' })
    expect(statement).toMatchObject({ netCents: 1, vatCents: 0, totalCents: 1 })
    await point(actor, { command: 'mark_statement_invoiced', operationId: randomUUID(), statementId: statement.id, evidence: 'Estado de cuenta manual sintético' })
    await point(actor, { command: 'record_commission_payment', operationId: randomUUID(), statementId: statement.id, amountCents: 1, paidAt: '2026-06-01T12:00:00Z', evidence: 'Referencia sintética de depósito' })
    await expect(point(actor, { command: 'record_commission_payment', operationId: randomUUID(), statementId: statement.id, amountCents: 1, paidAt: '2026-06-01T12:00:00Z', evidence: 'Sobrepago' })).rejects.toThrow('POINT_REFUND_LIMIT')
    await db.query('update app_private.point_settings set rate_bps=50,vat_bps=800,tariff_version=\'new-synthetic-tariff\' where business_id=$1', [actor.businessId])
    await service('apply_order', { ...evidence, state: 'partially_refunded', refunds: [{ id: 'late-1', amountCents: 66, confirmedAt: '2026-06-01T12:00:00Z' }] })
    const next = await point<CommissionStatement>(actor, { command: 'close_statement', operationId: randomUUID(), period: '2026-06' })
    await service('apply_order', { ...evidence, state: 'refunded', refunds: [{ id: 'late-1', amountCents: 66, confirmedAt: '2026-06-01T12:00:00Z' }, { id: 'late-2', amountCents: 101, confirmedAt: '2026-07-01T12:00:00Z' }] })
    const final = await point<CommissionStatement>(actor, { command: 'close_statement', operationId: randomUUID(), period: '2026-07' })
    expect(statement.netCents + next.netCents + final.netCents).toBe(0)
    expect(statement.vatCents + next.vatCents + final.vatCents).toBe(0)
    expect((await db.query<{ rate_bps: number; vat_bps: number }>("select rate_bps,vat_bps from app_private.point_fee_ledger where business_id=$1 and kind='refund'",[actor.businessId])).rows).toEqual([{rate_bps:30,vat_bps:1600},{rate_bps:30,vat_bps:1600}])
    expect((await point<{ statements: CommissionStatement[] }>(actor, { command: 'statements' })).statements.find(s => s.id === statement.id)).toMatchObject({ collectedCents: 1, remainingCents: 0, netCents: 1 })
  })

  it('reports complete authorized detail in business timezone and excludes sandbox fees', async () => {
    const { actor, checkout } = await setup(100_00000, 'sandbox')
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await service('apply_order', { ...await facts(started.attemptId!), state: 'approved_verified' })
    const report = await point<PointReport>(actor, { command: 'merchant_report', from: '2026-01-01', to: '2026-12-31' })
    expect(report).toMatchObject({ grossCents: 0, commissionNetCents: 0, costsCents: null, settlementCents: null })
    expect(report.daily.reduce((sum, row) => sum + row.grossCents, 0)).toBe(report.grossCents)
    await expect(point(actor, { command: 'merchant_report', from: '2026-01-01', to: '2028-01-01' })).rejects.toThrow('VALIDATION_ERROR')
    await db.query('insert into app_private.sasori_admins(user_id,active,granted_by,reason) values($1,true,\'synthetic test operator\',\'isolated test\')', [actor.userId])
    expect(await point(actor, { command: 'admin_report', from: '2026-01-01', to: '2026-01-31' })).toHaveProperty('businesses')
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.sasori_admin_audit where user_id=$1', [actor.userId])).rows[0].n).toBe(2)
  })

  it('binds one-use OAuth states and excludes simultaneous refresh claims', async () => {
    const { actor, connectionId } = await setup()
    const stateHash = 'ab'.repeat(32)
    const payload = { businessId: actor.businessId, userId: actor.userId, authSessionId: actor.sessionId, stateHash, redirectUri: 'http://127.0.0.1/callback', environment: 'live', verifierCiphertext: 'encrypted-test-only', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    await service('oauth_state_create', payload)
    await expect(service('oauth_state_consume', { ...payload, businessId: randomUUID() })).rejects.toThrow('POINT_OAUTH_INVALID')
    expect(await service('oauth_state_consume', payload)).toMatchObject({ businessId: actor.businessId, environment: 'live' })
    await expect(service('oauth_state_consume', payload)).rejects.toThrow('POINT_OAUTH_INVALID')
    const leaseToken = randomUUID()
    expect(await service('refresh_claim', { connectionId, leaseToken })).toHaveProperty('claimed', true)
    expect(await service('refresh_claim', { connectionId, leaseToken: randomUUID() })).toEqual({ claimed: false })
    await expect(service('refresh_save', { connectionId, leaseToken: randomUUID(), tokensCiphertext: 'encrypted-rotated', expiresAt: new Date().toISOString() })).rejects.toThrow('POINT_LEASE_LOST')
    await service('refresh_release', { connectionId, leaseToken, uncertain: true })
    expect((await point<PointSettings>(actor, { command: 'settings' })).connection?.status).toBe('reconnect_required')
  })

  it('persists early signed notifications before an order locator exists and counts durable duplicates', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, {command:'start',operationId:randomUUID(),checkoutId:checkout.id})
    const evidence = await facts(started.attemptId!)
    const event = {remoteOrderId:evidence.remoteOrderId,eventKey:'cd'.repeat(32),signatureTimestamp:'1791028800'}
    expect(await service('webhook_enqueue',event)).toMatchObject({accepted:true,matched:false})
    expect(await service('webhook_enqueue',event)).toMatchObject({accepted:true,matched:false})
    expect((await db.query<{n:number}>('select count(*)::int n from app_private.point_event_inbox where event_key=$1',[event.eventKey])).rows[0].n).toBe(1)
    await service('apply_order',{...evidence,state:'approved_verified'})
    await service('pending_sweep',{})
    expect((await db.query<{business_id:string;duplicate_count:number}>('select business_id,duplicate_count from app_private.point_event_inbox where event_key=$1',[event.eventKey])).rows[0]).toEqual({business_id:actor.businessId,duplicate_count:1})
    const report=await point<PointReport>(actor,{command:'merchant_report',from:'2026-01-01',to:'2026-12-31'})
    expect(report.health).toMatchObject({receivedEvents:1,duplicates:1,invalidSignatures:null})
    expect(report.lastReconciledAt).toBeTruthy()
  })

  it('uses inclusive local dates at midnight and preserves complete global detail across pages', async () => {
    const {actor,checkout}=await setup(1001)
    const started=await point<PointCheckout>(actor,{command:'start',operationId:randomUUID(),checkoutId:checkout.id})
    await service('apply_order',{...await facts(started.attemptId!),state:'approved_verified',observedAt:'2026-08-01T05:59:59Z'})
    const before=await point<PointReport>(actor,{command:'merchant_report',from:'2026-07-31',to:'2026-07-31'})
    const after=await point<PointReport>(actor,{command:'merchant_report',from:'2026-08-01',to:'2026-08-01'})
    expect(before.grossCents).toBe(1001);expect(after.grossCents).toBe(0)
    expect(before.daily.reduce((s,d)=>s+d.grossCents,0)).toBe(before.grossCents)
    await db.query("insert into app_private.sasori_admins(user_id,active,granted_by,reason) values($1,true,'test','pagination')",[actor.userId])
    await db.exec(`with tenants as(insert into app_private.businesses(name,business_type,timezone) select 'Synthetic pagination '||i,'cafe','UTC' from generate_series(1,101) i returning id)
      insert into app_private.point_connections(business_id,receiver_id,environment,status,tokens_ciphertext) select id,id::text,'live','connected','fixture-only' from tenants`)
    let cursor:string|null=null,total=0,rows=0,expected=0
    do {
      const page=await point<import('../../src/lib/point-contracts').PointAdminReport>(actor,{command:'admin_report',from:'2026-01-01',to:'2026-12-31',cursor})
      expected=page.grossCents;total+=page.businesses.reduce((s,b)=>s+b.grossCents,0);rows+=page.businesses.length;cursor=page.nextCursor
      expect(page.businesses.length).toBeLessThanOrEqual(100)
      expect(page.cohorts.reduce((s,c)=>s+c.grossCents,0)).toBe(page.grossCents)
    } while(cursor)
    expect(rows).toBeGreaterThan(100);expect(total).toBe(expected)
  })
})

async function newActor(): Promise<Actor> {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Comercio ficticio','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash","card_external","transfer"]}')`, [actor.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,\'owner\')', [actor.businessId, actor.userId])
  await db.query('insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,\'Propietario ficticio\',\'owner\')', [actor.employeeId, actor.businessId, actor.userId])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [actor.businessId, actor.userId, actor.sessionId, actor.token])
  return actor
}
async function pos<T = unknown>(actor: Actor, command: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: { data: T } }>(`select public.pos_execute($1,$2,$3,$4,$5::jsonb) result`, [actor.userId, actor.sessionId, actor.businessId, actor.token, JSON.stringify(command)])).rows[0].result.data
}
async function point<T = unknown>(actor: Actor, command: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: { data: T } }>(`select public.account_secure($1,$2,'point',$3::jsonb) result`, [actor.userId, actor.sessionId, JSON.stringify({ action: 'point', businessId: actor.businessId, operatorToken: actor.token, ...command })])).rows[0].result.data
}
async function service<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: T }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result
}
async function setup(price = 1001, environment = 'live') {
  const actor = await newActor(); await pos(actor, { command: 'activate_operations', operationId: randomUUID() }); await pos(actor, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const connection = await service<{ id: string }>('connection_save', { businessId: actor.businessId, environment, receiverId: randomUUID(), tokensCiphertext: 'encrypted-synthetic-tokens', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const terminalId = `SYNTHETIC-${randomUUID()}`
  await service('terminal_save', { connectionId: connection.id, terminalId, serial: terminalId, storeId: 'STORE-1', posId: 'POS-1', mode: 'PDV', verified: true, physicallyConfirmed: true })
  await point(actor, { command: 'activate', enabled: true })
  const product = await pos<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto ficticio', category: 'Bebidas', priceCents: price, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 } })
  const order = await pos<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta ficticia', tableId: null, items: [{ lineId: randomUUID(), productId: product.id, quantity: 1, unitPriceCents: price, version: product.version, note: '' }] })
  const reservation = await pos<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'card_integrated' })
  const checkout = await point<PointCheckout>(actor, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: reservation.id, terminalId })
  return { actor, checkout, reservation, connectionId: connection.id }
}
async function facts(attemptId: string) {
  const row = (await db.query<{ amount_cents: number; receiver_id: string; environment: string; external_reference: string }>('select amount_cents::integer,receiver_id,environment,external_reference from app_private.point_attempts where id=$1', [attemptId])).rows[0]
  return { attemptId, remoteOrderId: `ORDER-${attemptId}`, amountCents: row.amount_cents, receiverId: row.receiver_id, environment: row.environment, externalReference: row.external_reference, currency: 'MXN', observedAt: new Date().toISOString(), refunds: [] }
}
