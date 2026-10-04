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
let legacySandboxConnection: string
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string }
describe('Point private ledger and server reservations (single PostgreSQL session)', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) {
      if (file.endsWith('_point_shared_official_sandbox.sql')) {
        const actor = await newActor()
        await service('official_sandbox_connect', { businessId: actor.businessId, userId: actor.userId, authSessionId: actor.sessionId, operatorToken: actor.token,
          operationId: randomUUID(), receiverId: randomUUID(), tokensCiphertext: 'synthetic-legacy-vault', expiresAt: '2099-01-01T00:00:00Z' })
        legacySandboxConnection = (await point<PointSettings>(actor, { command: 'settings' })).connection!.id
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('preserves an already linked official sandbox when migrating receiver ownership', async () => {
    expect((await db.query('select official_sandbox,status,tokens_ciphertext,token_version from app_private.point_connections where id=$1', [legacySandboxConnection])).rows[0])
      .toEqual({ official_sandbox: true, status: 'connected', tokens_ciphertext: 'synthetic-legacy-vault', token_version: 1 })
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.point_service_before_shared_sandbox(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
    }
  })

  it('enrolls only an empty dedicated sandbox business and permanently blocks live reconnection', async () => {
    const actor = await newActor()
    const payload = { businessId: actor.businessId, userId: actor.userId, authSessionId: actor.sessionId, operatorToken: actor.token, operationId: randomUUID(), receiverId: randomUUID(), tokensCiphertext: 'synthetic-encrypted', expiresAt: '2099-01-01T00:00:00Z' }
    expect(await point(actor, { command: 'connect_sandbox', operationId: payload.operationId })).toMatchObject({ backendDirective: { kind: 'connect_sandbox' } })
    await service('official_sandbox_connect', payload)
    expect(await point<PointSettings>(actor, { command: 'settings' })).toMatchObject({ sandbox: { testBusiness: true }, connection: { environment: 'sandbox' }, terminals: [{ id: 'NEWLAND_N950__SBX0000001', active: true, verified: true }] })
    await point(actor, { command: 'disconnect' })
    await expect(point(actor, { command: 'oauth_start', operationId: randomUUID(), environment: 'live' })).rejects.toThrow('POINT_STATE_INVALID')
    await expect(service('connection_save', { ...payload, environment: 'live' })).rejects.toThrow('POINT_STATE_INVALID')
    await service('official_sandbox_connect', payload)
    await db.query('delete from auth.sessions where id=$1', [actor.sessionId])
    await expect(service('official_sandbox_connect', payload)).rejects.toThrow()
  })

  it('rejects official sandbox enrollment for business with live history and for employees', async () => {
    const { actor } = await setup()
    await expect(point(actor, { command: 'connect_sandbox', operationId: randomUUID() })).rejects.toThrow('POINT_STATE_INVALID')
    const employee = await newActor()
    await db.query("update app_private.employees set role='cashier' where id=$1", [employee.employeeId])
    await db.query("update app_private.business_memberships set role='cashier' where business_id=$1 and user_id=$2", [employee.businessId, employee.userId])
    await expect(point(employee, { command: 'connect_sandbox', operationId: randomUUID() })).rejects.toThrow('DEVICE_LINK_REQUIRED')
    await expect(db.query("select app_private.point_command($1,$2,$3::jsonb)", [employee.businessId, employee.employeeId, JSON.stringify({ command: 'connect_sandbox', operationId: randomUUID() })])).rejects.toThrow('PERMISSION_DENIED')
  })

  it('shares only the official virtual receiver while keeping each test business isolated', async () => {
    const first = await newActor(), second = await newActor()
    const receiverId = randomUUID()
    const payload = (actor: Actor) => ({ businessId: actor.businessId, userId: actor.userId, authSessionId: actor.sessionId, operatorToken: actor.token,
      operationId: randomUUID(), receiverId, tokensCiphertext: `synthetic-encrypted-${actor.businessId}`, expiresAt: '2099-01-01T00:00:00Z' })
    await service('official_sandbox_connect', payload(first))
    await service('official_sandbox_connect', payload(second))
    const one = await point<PointSettings>(first, { command: 'settings' }), two = await point<PointSettings>(second, { command: 'settings' })
    expect(one.connection!.id).not.toBe(two.connection!.id)
    for (const result of [one, two]) expect(result).toMatchObject({ sandbox: { testBusiness: true }, connection: { environment: 'sandbox', receiverId }, terminals: [{ id: 'NEWLAND_N950__SBX0000001', verified: true, active: true }] })
    const before = await service('connection_get', { connectionId: two.connection!.id })
    await service('official_sandbox_connect', payload(first))
    expect(await service('connection_get', { connectionId: two.connection!.id })).toEqual(before)
    await point(first, { command: 'disconnect' })
    expect((await point<PointSettings>(second, { command: 'settings' })).connection!.status).toBe('connected')
    await expect(service('connection_save', { ...payload(first), environment: 'sandbox' })).rejects.toThrow('POINT_FACT_MISMATCH')
    const third = await newActor()
    await expect(service('connection_save', { ...payload(third), environment: 'sandbox' })).rejects.toThrow('POINT_FACT_MISMATCH')
    // Ordinary OAuth sandbox credentials retain the original one-business boundary.
    const ordinary = { ...payload(first), receiverId: randomUUID(), environment: 'sandbox' }
    await service('connection_save', { ...ordinary, businessId: third.businessId })
    await expect(service('connection_save', { ...ordinary, businessId: second.businessId })).rejects.toThrow('POINT_FACT_MISMATCH')
    const fourth = await newActor()
    await expect(service('official_sandbox_connect', { ...payload(fourth), receiverId: ordinary.receiverId })).rejects.toThrow('POINT_FACT_MISMATCH')
    expect((await point<PointSettings>(fourth, { command: 'settings' })).sandbox!.testBusiness).toBe(false)
    await expect(db.query('update app_private.point_connections set official_sandbox=false where id=$1', [two.connection!.id])).rejects.toThrow('POINT_STATE_INVALID')
    const live = { ...payload(fourth), receiverId: randomUUID(), environment: 'live' }
    await service('connection_save', live)
    await expect(service('connection_save', { ...live, businessId: third.businessId })).rejects.toThrow('POINT_FACT_MISMATCH')
  })

  it('never mixes payments or simulation permissions between businesses sharing the virtual receiver', async () => {
    const receiverId = randomUUID()
    const first = await setup(500, 'sandbox', true, receiverId), second = await setup(76068, 'sandbox', true, receiverId)
    const one = await point<PointCheckout>(first.actor, { command: 'start', operationId: randomUUID(), checkoutId: first.checkout.id })
    // The shared terminal still accepts only one unresolved checkout at a time.
    await expect(point(second.actor, { command: 'start', operationId: randomUUID(), checkoutId: second.checkout.id })).rejects.toThrow('POINT_TERMINAL_BUSY')
    await expect(point(first.actor, { command: 'status', checkoutId: second.checkout.id })).rejects.toThrow('POINT_CHECKOUT_NOT_FOUND')
    await expect(point(first.actor, { command: 'simulate', checkoutId: second.checkout.id, status: 'processed' })).rejects.toThrow('POINT_CHECKOUT_NOT_FOUND')
    await service('apply_order', { ...await facts(one.attemptId!), state: 'approved_verified' })
    expect(await point<PointCheckout>(first.actor, { command: 'status', checkoutId: one.id })).toMatchObject({ saleState: 'materialized', sale: { totalCents: 500 } })
    expect(await point<PointCheckout>(second.actor, { command: 'status', checkoutId: second.checkout.id })).toMatchObject({ saleState: 'pending', sale: null })
    const two = await point<PointCheckout>(second.actor, { command: 'start', operationId: randomUUID(), checkoutId: second.checkout.id })
    await service('apply_order', { ...await facts(two.attemptId!), state: 'approved_verified' })
    expect(await point<PointCheckout>(second.actor, { command: 'status', checkoutId: two.id })).toMatchObject({ saleState: 'materialized', sale: { totalCents: 76068 } })
    await db.query("update app_private.point_jobs set status='done' where attempt_id in ($1,$2)", [one.attemptId, two.attemptId])
  })

  it('authorizes simulation only for own official sandbox checkout, never writes a payment result', async () => {
    const { actor, checkout } = await setup(1001, 'sandbox', true)
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await db.query("update app_private.point_attempts set remote_order_id='ORD-SANDBOX' where id=$1", [started.attemptId])
    expect(await point(actor, { command: 'simulate', checkoutId: checkout.id, status: 'processed' })).toMatchObject({ backendDirective: { remoteOrderId: 'ORD-SANDBOX' } })
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.sales where business_id=$1', [actor.businessId])).rows[0].n).toBe(0)
    await expect(point(actor, { command: 'simulate', checkoutId: checkout.id, status: 'refunded' })).rejects.toThrow('VALIDATION_ERROR')
    await db.query("update app_private.point_jobs set status='done' where attempt_id=$1", [started.attemptId])
    const other = await newActor()
    await expect(point(other, { command: 'simulate', checkoutId: checkout.id, status: 'processed' })).rejects.toThrow('POINT_CHECKOUT_NOT_FOUND')
    const live = await setup()
    await expect(point(live.actor, { command: 'simulate', checkoutId: live.checkout.id, status: 'processed' })).rejects.toThrow('POINT_STATE_INVALID')
  })

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
    const jobs = await service<{ jobs: { id: string; leaseToken: string; payload: { createPayload: { transactions: { payments: { amount: string }[] } }; idempotencyKey: string; firstSentAt: string } }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: true })
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
    await expect(point(actor, { ...refund, operationId: randomUUID() })).rejects.toThrow('POINT_RESULT_UNCERTAIN')
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

  it('keeps definitive failures immutable and requires a fresh checkout after rejection', async () => {
    const { actor, checkout, reservation } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = { ...await facts(started.attemptId!), state: 'rejected' }
    await service('apply_order', evidence)
    await service('apply_order', evidence)
    await expect(point(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })).rejects.toThrow('POINT_STATE_INVALID')
    expect((await pos<CheckoutAttempt>(actor, { command: 'attempt', attemptId: reservation.id })).status).toBe('aborted')
    const current = await pos<OperationalOrder>(actor, { command: 'order', orderId: reservation.orderId })
    const next = await pos<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: current.id, expectedRevision: current.revision, items: current.items.map(line => ({ lineId: line.lineId, quantity: line.quantity - line.paidQuantity })), paymentMethod: 'card_integrated' })
    const prepared = await point<PointCheckout>(actor, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: next.id, terminalId: checkout.terminal.id })
    expect((await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: prepared.id })).state).toBe('pending')
    expect(next.id).not.toBe(reservation.id)
  })

  it('shows cancelled before sending and does not revive an aborted reservation', async () => {
    const { actor, checkout } = await setup()
    expect(await point(actor, { command: 'cancel', checkoutId: checkout.id })).toMatchObject({ state: 'cancelled', saleState: 'pending' })
    await expect(point(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })).rejects.toThrow('POINT_STATE_INVALID')
  })

  it('keeps new jobs queued when charges are disabled but permits the original sent identity', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await db.query("update app_private.point_jobs set available_at='-infinity' where attempt_id=$1", [started.attemptId])
    await point(actor, { command: 'activate', enabled: false })
    let jobs = await service<{ jobs: { id: string; attemptId: string; leaseToken: string }[] }>('claim_jobs', { limit: 100, leaseToken: randomUUID(), chargesEnabled: true })
    expect(jobs.jobs.some(job => job.attemptId === started.attemptId)).toBe(false)
    await point(actor, { command: 'activate', enabled: true })
    jobs = await service('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: true })
    const job = jobs.jobs[0]
    expect(job.attemptId).toBe(started.attemptId)
    await service('fail_job', { id: job.id, leaseToken: job.leaseToken, code: 'UNCERTAIN', uncertain: true, delaySeconds: 1 })
    await point(actor, { command: 'activate', enabled: false })
    await db.query("update app_private.point_jobs set available_at='-infinity' where id=$1", [job.id])
    const retry = await service<{ jobs: { id: string; payload: { idempotencyKey: string } }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: false })
    expect(retry.jobs[0]).toMatchObject({ id: job.id, payload: { idempotencyKey: started.attemptId } })
  })

  it('recovers refund requests across clients and never attributes an external refund by matching amount', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'approved_verified' })
    const request = { command: 'refund', operationId: randomUUID(), checkoutId: checkout.id, amountCents: 200, merchandiseCents: 200, tipCents: 0, reason: 'Reembolso' }
    const created = await point<PointCheckout>(actor, request)
    expect(created.refundRequests).toHaveLength(1)
    expect(created.refundRequests[0]).toMatchObject({ operationId: request.operationId, status: 'pending', amountCents: 200, firstSentAt: null })
    await expect(point(actor, { ...request, operationId: randomUUID() })).rejects.toThrow('POINT_RESULT_UNCERTAIN')
    await service('apply_order', { ...evidence, state: 'partially_refunded', refunds: [{ id: 'outside-request', amountCents: 200, confirmedAt: new Date().toISOString() }] })
    expect((await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })).refundRequests[0].status).toBe('pending')
    const requestId = created.refundRequests[0].id
    await db.query("update app_private.point_jobs set available_at='-infinity' where refund_id=$1", [requestId])
    const claimed = await service<{ jobs: { id: string; leaseToken: string; payload: { refundRequest: { id: string; firstSentAt: string } } }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: true })
    const job = claimed.jobs[0]
    expect(job.payload.refundRequest.id).toBe(requestId)
    expect(job.payload.refundRequest.firstSentAt).toBeTruthy()
    await expect(service('record_remote_refund', { jobId: job.id, leaseToken: randomUUID(), refundId: requestId, remoteRefundId: 'own-refund' })).rejects.toThrow('POINT_LEASE_LOST')
    await service('record_remote_refund', { jobId: job.id, leaseToken: job.leaseToken, refundId: requestId, remoteRefundId: 'own-refund' })
    await expect(service('record_remote_refund', { jobId: job.id, leaseToken: job.leaseToken, refundId: requestId, remoteRefundId: 'different-refund' })).rejects.toThrow('POINT_FACT_MISMATCH')
    await service('apply_order', { ...evidence, state: 'partially_refunded', refunds: [{ id: 'outside-request', amountCents: 200, confirmedAt: new Date().toISOString() }, { id: 'own-refund', amountCents: 200, confirmedAt: new Date().toISOString() }] })
    expect((await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })).refundRequests[0]).toMatchObject({ status: 'confirmed', remoteRefundId: 'own-refund' })
    await point(actor, { ...request, operationId: randomUUID() })
  })

  it('counts integrated sales and provider refunds in ordinary reports and chart intervals', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'approved_verified', observedAt: '2026-08-01T12:00:00Z' })
    await service('apply_order', { ...evidence, state: 'partially_refunded', refunds: [{ id: 'report-refund', amountCents: 201, confirmedAt: '2026-08-01T13:00:00Z' }] })
    const report = await pos<{ totals: import('../../src/lib/operations-contracts').BusinessDayReport; series: { reversalCents: number; netCents: number }[] }>(actor, { command: 'report_period', date: '2026-08-01', period: 'day' })
    expect(report.totals).toMatchObject({ salesCents: 1001, reversalCents: 201, netCents: 800, unallocatedRefundCents: 201, unknownReversalTaxCents: 201 })
    expect(report.totals.payments.find(row => row.paymentMethod === 'card_integrated')).toMatchObject({ salesCents: 1001, reversalCents: 201, netCents: 800 })
    expect(report.totals.operators[0]).toMatchObject({ salesCents: 1001, reversalCents: 201, netCents: 800 })
    expect(report.totals.products[0].reversalQuantity).toBe(0)
    expect(report.series.reduce((sum, row) => sum + row.reversalCents, 0)).toBe(201)
    expect(report.series.reduce((sum, row) => sum + row.netCents, 0)).toBe(800)
  })

  it('rejects provider identity and financial statement rewriting', async () => {
    const { actor, checkout } = await setup(1001)
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await expect(db.query('update app_private.point_attempts set amount_cents=999 where id=$1', [started.attemptId])).rejects.toThrow('IMMUTABLE_FINANCIAL_RECORD')
    await expect(db.query('update app_private.point_checkouts set rate_bps=999 where id=$1', [checkout.id])).rejects.toThrow('IMMUTABLE_FINANCIAL_RECORD')
    await service('apply_order', { ...await facts(started.attemptId!), state: 'approved_verified', observedAt: '2026-05-01T12:00:00Z' })
    const statement = await point<CommissionStatement>(actor, { command: 'close_statement', operationId: randomUUID(), period: '2026-05' })
    await expect(db.query('update app_private.point_statements set net_cents=100,total_cents=100+vat_cents where id=$1', [statement.id])).rejects.toThrow('IMMUTABLE_FINANCIAL_RECORD')
    await expect(db.query('delete from app_private.point_statement_lines where statement_id=$1', [statement.id])).rejects.toThrow('IMMUTABLE_FINANCIAL_RECORD')
  })

  it('does not revoke a reconnected account after a stale-token failure', async () => {
    const { actor, connectionId } = await setup()
    const original = await service<{ tokenVersion: number; receiverId: string }>('connection_get', { connectionId })
    await service('connection_save', { businessId: actor.businessId, environment: 'live', receiverId: original.receiverId, tokensCiphertext: 'synthetic-reconnected', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(await service('connection_revoke', { connectionId, expectedTokenVersion: original.tokenVersion })).toEqual({ revoked: false })
    const current = await service<{ tokenVersion: number; status: string }>('connection_get', { connectionId })
    expect(current.tokenVersion).toBe(original.tokenVersion + 1)
    expect(current.status).toBe('connected')
    await service('connection_revoke', { connectionId, expectedTokenVersion: current.tokenVersion })
    expect(await service('connection_get', { connectionId })).toMatchObject({ status: 'revoked' })
  })

  it('releases a prepared terminal reservation without a provider attempt while preserving the started guard', async () => {
    const { actor, checkout, reservation } = await setup()
    const release = { command: 'resolve_checkout', operationId: randomUUID(), attemptId: reservation.id, expectedRevision: reservation.revision, resolution: 'abort', confirmed: true, reason: 'Editar cuenta' }
    const released = await pos<CheckoutAttempt>(actor, release)
    expect(await pos(actor, release)).toEqual(released)
    expect(released.status).toBe('aborted')
    expect((await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })).state).toBe('cancelled')
    const next = await setup()
    await point(next.actor, { command: 'start', operationId: randomUUID(), checkoutId: next.checkout.id })
    const started = await pos<CheckoutAttempt>(next.actor, { command: 'attempt', attemptId: next.reservation.id })
    await expect(pos(next.actor, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: started.id, expectedRevision: started.revision, resolution: 'abort', confirmed: true, reason: 'Editar cuenta' })).rejects.toThrow('POINT_RESULT_UNCERTAIN')
  })

  it('settles already-sent approval while new business charges are disabled', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'unknown_review', statusDetail: 'action_required' })
    await point(actor, { command: 'activate', enabled: false })
    await service('apply_order', { ...evidence, state: 'approved_verified' })
    expect(await point(actor, { command: 'status', checkoutId: checkout.id })).toMatchObject({ saleState: 'materialized', state: 'approved_verified' })
  })

  it('holds a physical terminal reservation across a receiver reconnection', async () => {
    const { actor, checkout, connectionId } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await service('apply_order', { ...await facts(started.attemptId!), state: 'unknown_review' })
    const other = await service<{ id: string }>('connection_save', { businessId: actor.businessId, environment: 'live', receiverId: randomUUID(), tokensCiphertext: 'synthetic-other-collector', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(other.id).not.toBe(connectionId)
    await expect(service('terminal_save', { connectionId: other.id, terminalId: checkout.terminal.id, serial: checkout.terminal.serial, storeId: 'NEW-STORE', posId: 'NEW-POS', mode: 'PDV', verified: true, physicallyConfirmed: true })).rejects.toThrow('POINT_TERMINAL_BUSY')
    expect((await db.query<{ connection_id: string }>('select connection_id from app_private.point_terminal_reservations where attempt_id=$1', [started.attemptId])).rows[0].connection_id).toBe(connectionId)
  })

  it('sweeps an old uncertain attempt even without a new webhook', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await service('apply_order', { ...await facts(started.attemptId!), state: 'unknown_review' })
    await db.query("update app_private.point_jobs set status='done' where attempt_id=$1", [started.attemptId])
    await db.query("update app_private.point_attempts set observed_at=clock_timestamp()-interval '10 minutes',updated_at=clock_timestamp()-interval '10 minutes' where id=$1", [started.attemptId])
    await point(actor, { command: 'activate', enabled: false })
    await service('pending_sweep', {})
    expect((await db.query<{ n: number }>("select count(*)::int n from app_private.point_jobs where attempt_id=$1 and kind='reconcile_order' and status='queued'", [started.attemptId])).rows[0].n).toBe(1)
  })

  it('recovers an expired final worker lease without releasing uncertain money or terminal', async () => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    await service('apply_order', { ...await facts(started.attemptId!), state: 'unknown_review' })
    await db.query("update app_private.point_jobs set status='leased',attempts=12,lease_token=$2,lease_until=clock_timestamp()-interval '1 minute' where attempt_id=$1", [started.attemptId, randomUUID()])
    await db.query("update app_private.point_attempts set observed_at=clock_timestamp()-interval '10 minutes' where id=$1", [started.attemptId])
    await service('pending_sweep', {})
    const jobs = (await db.query<{ kind: string; status: string; last_error: string | null }>('select kind,status,last_error from app_private.point_jobs where attempt_id=$1 order by created_at', [started.attemptId])).rows
    expect(jobs).toEqual([{ kind: 'create_order', status: 'failed', last_error: 'POINT_LEASE_EXHAUSTED' }, { kind: 'reconcile_order', status: 'queued', last_error: null }])
    expect((await db.query<{ n: number }>('select count(*)::int n from app_private.point_terminal_reservations where attempt_id=$1', [started.attemptId])).rows[0].n).toBe(1)
    await service('pending_sweep', {})
    expect((await db.query<{ n: number }>("select count(*)::int n from app_private.point_incidents where attempt_id=$1 and code='retries_exhausted'", [started.attemptId])).rows[0].n).toBe(1)
  })

  it.each([false, true])('preserves the settled payment when a refund worker fails after a timeout (partial=%s)', async (partial) => {
    const { actor, checkout } = await setup()
    const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const evidence = await facts(started.attemptId!)
    await service('apply_order', { ...evidence, state: 'approved_verified' })
    if (partial) await service('apply_order', { ...evidence, state: 'partially_refunded', refunds: [{ id: 'previous-refund', amountCents: 101, confirmedAt: new Date().toISOString() }] })
    const pending = await point<PointCheckout>(actor, { command: 'refund', operationId: randomUUID(), checkoutId: checkout.id, amountCents: 200, merchandiseCents: 200, tipCents: 0, reason: 'Reembolso con respuesta perdida' })
    const request = pending.refundRequests[0]
    await db.query("update app_private.point_jobs set available_at='-infinity' where refund_id=$1", [request.id])
    const claimed = await service<{ jobs: { id: string; leaseToken: string }[] }>('claim_jobs', { limit: 1, leaseToken: randomUUID(), chargesEnabled: true })
    const job = claimed.jobs[0]
    await service('fail_job', { id: job.id, leaseToken: job.leaseToken, code: 'UNCERTAIN', uncertain: true, delaySeconds: 1 })
    const recovered = await point<PointCheckout>(actor, { command: 'status', checkoutId: checkout.id })
    expect(recovered).toMatchObject({ state: partial ? 'partially_refunded' : 'approved_verified', saleState: 'materialized', refundedCents: partial ? 101 : 0 })
    expect(recovered.refundRequests[0]).toMatchObject({ id: request.id, status: 'unknown_review' })
    expect((await db.query<{ status: string; last_error: string }>('select status,last_error from app_private.point_jobs where id=$1', [job.id])).rows[0]).toEqual({ status: 'queued', last_error: 'UNCERTAIN' })
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
async function setup(price = 1001, environment = 'live', official = false, receiverId = randomUUID()) {
  const actor = await newActor(); await pos(actor, { command: 'activate_operations', operationId: randomUUID() }); await pos(actor, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  if (official) await service('official_sandbox_connect', { businessId: actor.businessId, userId: actor.userId, authSessionId: actor.sessionId, operatorToken: actor.token, operationId: randomUUID(), receiverId, tokensCiphertext: 'synthetic-test-token', expiresAt: '2099-01-01T00:00:00Z' })
  const connection = official ? (await point<PointSettings>(actor, { command: 'settings' })).connection! : await service<{ id: string }>('connection_save', { businessId: actor.businessId, environment, receiverId: randomUUID(), tokensCiphertext: 'encrypted-synthetic-tokens', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const terminalId = official ? 'NEWLAND_N950__SBX0000001' : `SYNTHETIC-${randomUUID()}`
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
