import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CashShift, CheckoutAttempt, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { PaymentMethod } from '../../src/lib/contracts'
import type { PointCheckout } from '../../src/lib/point-contracts'
import { emptyDetails } from '../../src/lib/product-details'
import { assertFinancialResponse } from '../../src/lib/financial-response'

type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite
let legacy: { actor: Actor; command: Extract<PosCommand, { command: 'open_shift' }>; result: CashShift }

describe('persisted payment totals attributed to a cash shift', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
      if (file === '20261006213000_shift_payment_summary.sql') {
        const actor = await newActor(); await activate(actor)
        const command = { command: 'open_shift' as const, operationId: randomUUID(), openingCents: 123 }
        legacy = { actor, command, result: await execute<CashShift>(actor, command) }
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('preserves an accepted pre-migration response and refreshes money even when the shift revision did not change', async () => {
    expect(legacy.result.paymentSummary).toBeUndefined()
    expect(await execute(legacy.actor, legacy.command)).toEqual(legacy.result)
    const before = await activeShift(legacy.actor)
    const paid = await pay(legacy.actor, await order(legacy.actor, await product(legacy.actor, 1001)), 'cash')
    const after = await activeShift(legacy.actor)
    expect(after.revision).toBe(before.revision)
    expect(after.paymentSummary).toMatchObject({ collectedCents: 1001, refundedCents: 0, netCents: 1001 })
    expect(after.paymentSummary!.payments.find(row => row.paymentMethod === 'cash')).toMatchObject({ collectedCents: paid.attempt.totalCents })
    expect(await execute(legacy.actor, legacy.command)).toEqual(legacy.result)
    assertFinancialResponse(legacy.command, legacy.result)
    const expensive = await product(legacy.actor, 99_999_999)
    for (let count = 0; count < 3; count++) await pay(legacy.actor, await order(legacy.actor, expensive, 100), 'transfer')
    expect((await activeShift(legacy.actor)).paymentSummary).toMatchObject({ collectedCents: 30_000_000_701, refundedCents: 0, netCents: 30_000_000_701 })
  })

  it('counts each persisted receipt once across all four methods and preserves unattributed Point refunds', async () => {
    const actor = await newActor(); await activate(actor); await open(actor, 99999)
    const item = await product(actor, 1001)
    const cash = await pay(actor, await order(actor, item), 'cash')
    expect(await execute(actor, cash.command)).toEqual(cash.result)
    await pay(actor, await order(actor, item), 'card_external')
    await pay(actor, await order(actor, item), 'transfer')
    const pointFacts = await pointPayment(actor, await order(actor, item))
    await service('apply_order', pointFacts)
    await service('apply_order', pointFacts)
    // Only completed receipt links count. A prepared/aborted quote is never revenue.
    const pendingOrder = await order(actor, item)
    const pending = await reserve(actor, pendingOrder, 'cash')
    expect((await activeShift(actor)).paymentSummary).toMatchObject({ collectedCents: 4004, refundedCents: 0, netCents: 4004 })
    await execute(actor, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: pending.id, expectedRevision: pending.revision, resolution: 'abort', confirmed: true, reason: 'Sin pago' })
    // A legacy receipt has no accepted checkout/shift attribution. Do not infer it from its day.
    await legacyReceipt(actor, item, 7001)
    // Fixture-only calendar changes prove aggregation follows the shift, not receipt dates.
    await db.transaction(async transaction => {
      await transaction.exec('set constraints all immediate; alter table app_private.sales disable trigger financial_history_immutable')
      await transaction.query("update app_private.sales set created_at='2001-01-01T00:00:00Z' where id=$1", [cash.attempt.saleId])
      await transaction.exec('alter table app_private.sales enable trigger financial_history_immutable')
    })
    await service('apply_order', { ...pointFacts, state: 'partially_refunded', refunds: [{ id: 'synthetic-point-refund', amountCents: 101, confirmedAt: new Date().toISOString() }] })
    expect((await db.query<{ amount: number }>('select sum(amount_cents)::integer amount from app_private.point_refunds where business_id=$1', [actor.businessId])).rows[0].amount).toBe(101)
    const summary = (await activeShift(actor)).paymentSummary!
    expect(summary).toMatchObject({ collectedCents: 4004, refundedCents: 0, netCents: 4004, pointRefundsNotAttributed: true })
    expect(summary.payments).toEqual(['cash', 'card_external', 'card_integrated', 'transfer'].map(paymentMethod => ({ paymentMethod, collectedCents: 1001, refundedCents: 0, netCents: 1001 })))
  })

  it('separates same-day shifts and tenants, assigns reversals to their actual refund shift and keeps counting blind', async () => {
    const actor = await newActor(); await activate(actor); const first = await open(actor, 100)
    const item = await product(actor, 1001)
    const cash = await pay(actor, await order(actor, item), 'cash')
    const external = await pay(actor, await order(actor, item), 'card_external')
    let closing = await execute<CashShift>(actor, { command: 'begin_shift_close', operationId: randomUUID(), shiftId: first.id, expectedRevision: first.revision })
    expect(closing.paymentSummary).toBeUndefined()
    expect((await activeShift(actor)).paymentSummary).toBeUndefined()
    expect((await shifts(actor)).find(shift => shift.id === first.id)!.paymentSummary).toBeUndefined()
    const closeCommand = { command: 'close_shift' as const, operationId: randomUUID(), shiftId: first.id, expectedRevision: closing.revision, countedCents: 1101 }
    const closed = await execute<CashShift>(actor, closeCommand)
    expect(closed).toMatchObject({ expectedCents: 1101, differenceCents: 0, paymentSummary: { collectedCents: 2002, refundedCents: 0, netCents: 2002 } })
    const second = await open(actor, 2000)
    await refund(actor, cash.attempt.saleId!); await refund(actor, external.attempt.saleId!)
    await pay(actor, await order(actor, item), 'transfer')
    const other = await newActor(); await activate(other); await open(other)
    await pay(other, await order(other, await product(other, 9900)), 'cash')
    const summary = (await activeShift(actor)).paymentSummary!
    expect(summary).toMatchObject({ collectedCents: 1001, refundedCents: 2002, netCents: -1001 })
    expect(summary.payments.find(row => row.paymentMethod === 'cash')).toMatchObject({ collectedCents: 0, refundedCents: 1001, netCents: -1001 })
    expect(summary.payments.find(row => row.paymentMethod === 'card_external')).toMatchObject({ collectedCents: 0, refundedCents: 1001, netCents: -1001 })
    expect((await shifts(actor)).find(shift => shift.id === first.id)!.paymentSummary).toEqual(closed.paymentSummary)
    expect((await shifts(other)).some(shift => shift.id === second.id)).toBe(false)
    expect(await execute(actor, closeCommand)).toEqual(closed)
    closing = await execute(actor, { command: 'begin_shift_close', operationId: randomUUID(), shiftId: second.id, expectedRevision: second.revision })
    const final = await execute<CashShift>(actor, { command: 'close_shift', operationId: randomUUID(), shiftId: second.id, expectedRevision: closing.revision, countedCents: 999 })
    expect(final).toMatchObject({ expectedCents: 999, differenceCents: 0, paymentSummary: summary })
  })

  it('masks ungranted monetary reads and retains live authorization and private helper boundaries', async () => {
    const actor = await newActor(); await activate(actor); const opened = await open(actor)
    const cashier = await newActor(actor.businessId, ['catalog.read', 'sales.create'])
    const masked = await activeShift(cashier)
    expect(masked).toMatchObject({ id: opened.id, openingCents: 0, countedCents: null, expectedCents: null, movements: [] })
    expect(masked.paymentSummary).toBeUndefined()
    await expect(shifts(cashier)).rejects.toThrow('PERMISSION_DENIED')
    const reader = await newActor(actor.businessId, ['cash.read'])
    expect((await shifts(reader))[0].paymentSummary).toBeDefined()
    await db.query('delete from auth.sessions where id=$1', [reader.sessionId])
    await expect(shifts(reader)).rejects.toThrow()
    for (const signature of ['app_private.ops_shift_payment_summary(uuid,uuid)', 'app_private.ops_shift_json(app_private.cash_shifts)', 'app_private.pos_command_before_shift_summary(uuid,uuid,jsonb)', 'app_private.pos_command(uuid,uuid,jsonb)']) {
      for (const role of ['anon', 'authenticated']) {
        expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
      }
      expect((await db.query<{ config: string[] }>('select proconfig config from pg_proc where oid=$1::regprocedure', [signature])).rows[0].config).toContain('search_path=""')
    }
    const command = { command: 'cash_movement' as const, operationId: randomUUID(), shiftId: opened.id, expectedRevision: opened.revision, kind: 'in' as const, amountCents: 10, reason: 'Entrada sintética' }
    await execute(actor, command)
    await db.query('delete from auth.sessions where id=$1', [actor.sessionId])
    await expect(execute(actor, command)).rejects.toThrow()
  })
})

async function newActor(existingBusiness?: string, permissions?: string[]): Promise<Actor> {
  const role = existingBusiness ? 'cashier' : 'owner'
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash","card_external","card_integrated","transfer"]}')`, [actor.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [actor.businessId, actor.userId, role])
  await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,\'Persona sintética\',$4,$5)', [actor.employeeId, actor.businessId, actor.userId, role, permissions ?? []])
  await db.query('insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,\'sha256\'))', [actor.businessId, actor.userId, actor.sessionId, actor.token])
  if (existingBusiness) {
    await db.query('insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,\'hex\'),\'Navegador sintético\')', [actor.businessId, actor.employeeId, actor.keyHash])
    await db.query('update app_private.operator_sessions set employee_device_key_hash=decode($1,\'hex\') where business_id=$2 and user_id=$3', [actor.keyHash, actor.businessId, actor.userId])
  }
  return actor
}
async function execute<T = unknown>(actor: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.account_secure($1,$2,\'pos\',$3::jsonb,$4,$5) result', [actor.userId, actor.sessionId, JSON.stringify({ action: 'pos', businessId: actor.businessId, operatorToken: actor.token, ...command }), actor.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  assertFinancialResponse(command, result.data)
  return result.data
}
async function activate(actor: Actor) { await execute(actor, { command: 'activate_operations', operationId: randomUUID() }) }
async function open(actor: Actor, openingCents = 0) { return execute<CashShift>(actor, { command: 'open_shift', operationId: randomUUID(), openingCents }) }
async function activeShift(actor: Actor) { return (await execute<OperationsSnapshot>(actor, { command: 'operations' })).shift! }
async function shifts(actor: Actor) { return (await execute<{ shifts: CashShift[] }>(actor, { command: 'shifts' })).shifts }
async function product(actor: Actor, priceCents: number) { return execute<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 } }) }
async function order(actor: Actor, item: Product, quantity = 1) { return execute<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind: 'counter', name: 'Mostrador', tableId: null, items: [{ lineId: randomUUID(), productId: item.id, quantity, unitPriceCents: item.priceCents, version: item.version, note: '' }] }) }
async function reserve(actor: Actor, account: OperationalOrder, paymentMethod: PaymentMethod) { return execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, items: [{ lineId: account.items[0].lineId, quantity: account.items[0].quantity }], paymentMethod }) }
async function pay(actor: Actor, account: OperationalOrder, paymentMethod: PaymentMethod) {
  const attempt = await reserve(actor, account, paymentMethod)
  const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true as const }
  const result = await execute<{ order: OperationalOrder; attempt: CheckoutAttempt }>(actor, command)
  return { command, result, attempt: result.attempt }
}
async function refund(actor: Actor, saleId: string) {
  let attempt = await execute<CheckoutAttempt>(actor, { command: 'prepare_reversal', operationId: randomUUID(), saleId, reason: 'Devolución sintética' })
  attempt = await execute(actor, { command: 'start_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision })
  return execute(actor, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, resolution: 'complete', confirmed: true, reason: 'Dinero devuelto' })
}
async function service<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> { return (await db.query<{ result: T }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result }
async function point<T = unknown>(actor: Actor, command: Record<string, unknown>): Promise<T> { return (await db.query<{ result: { data: T } }>('select public.account_secure($1,$2,\'point\',$3::jsonb) result', [actor.userId, actor.sessionId, JSON.stringify({ action: 'point', businessId: actor.businessId, operatorToken: actor.token, ...command })])).rows[0].result.data }
async function pointPayment(actor: Actor, account: OperationalOrder) {
  const connection = await service<{ id: string }>('connection_save', { businessId: actor.businessId, environment: 'sandbox', receiverId: randomUUID(), tokensCiphertext: 'encrypted-synthetic-tokens', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const terminalId = `SYNTHETIC-${randomUUID()}`
  await service('terminal_save', { connectionId: connection.id, terminalId, serial: terminalId, storeId: 'STORE-1', posId: 'POS-1', mode: 'PDV', verified: true, physicallyConfirmed: true })
  await point(actor, { command: 'activate', enabled: true })
  const reservation = await reserve(actor, account, 'card_integrated')
  const checkout = await point<PointCheckout>(actor, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: reservation.id, terminalId })
  const started = await point<PointCheckout>(actor, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
  const row = (await db.query<{ amount_cents: number; receiver_id: string; environment: string; external_reference: string }>('select amount_cents::integer,receiver_id,environment,external_reference from app_private.point_attempts where id=$1', [started.attemptId])).rows[0]
  return { attemptId: started.attemptId, remoteOrderId: `ORDER-${started.attemptId}`, amountCents: row.amount_cents, receiverId: row.receiver_id, environment: row.environment, externalReference: row.external_reference, currency: 'MXN', observedAt: new Date().toISOString(), state: 'approved_verified', refunds: [] }
}
async function legacyReceipt(actor: Actor, item: Product, amount: number) {
  await db.transaction(async transaction => {
    const saleId = randomUUID()
    await transaction.query('insert into app_private.sales(id,business_id,employee_id,operator_name,operation_id,total_cents,item_count,payment_method,timezone) values($1,$2,$3,\'Histórico sintético\',$4,$5,1,\'cash\',\'America/Mexico_City\')', [saleId, actor.businessId, actor.employeeId, randomUUID(), amount])
    await transaction.query('insert into app_private.sale_items(business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents) values($1,$2,$3,\'Histórico sintético\',\'\',1,$4::integer,$4::bigint)', [actor.businessId, saleId, item.id, amount])
  })
}
