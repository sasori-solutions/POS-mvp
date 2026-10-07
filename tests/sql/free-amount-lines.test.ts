import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { OperationalOrder, CheckoutAttempt, BusinessPeriodReport, OrderInputLine } from '../../src/lib/operations-contracts'
import type { Product, Sale } from '../../src/lib/pos-contracts'
import type { PointCheckout } from '../../src/lib/point-contracts'

type Actor = { businessId: string; userId: string; sessionId: string; employeeId: string; token: string; keyHash?: string }
const migration = '20261005180000_free_amount_lines.sql'
let db: PGlite, legacy: Actor, oldPayload: Record<string, unknown>, oldReceipt: Sale
const amount = (cents = 1001, name = '', quantity = 1) => ({ kind: 'amount' as const, name, quantity, unitPriceCents: cents })
const orderAmount = (cents = 1001, name = '', quantity = 1): OrderInputLine => ({ ...amount(cents, name, quantity), lineId: randomUUID(), note: '' })

describe('explicit amount lines without a catalog product', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    const files = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()
    for (const file of files.filter(file => file < migration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    legacy = await actor(false)
    const product = await pos<Product>(legacy, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto histórico sintético', category: '', priceCents: 1001 })
    oldPayload = { command: 'complete_sale', operationId: randomUUID(), paymentMethod: 'cash', totalCents: 1001, items: [{ productId: product.id, version: product.version, quantity: 1, unitPriceCents: 1001 }] }
    oldReceipt = await pos(legacy, oldPayload)
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  test('preserves the exact accepted historical product receipt and replay after upgrading', async () => {
    expect(await pos(legacy, oldPayload)).toEqual(oldReceipt)
    expect(await pos(legacy, { command: 'sale', saleId: oldReceipt.id })).toEqual(oldReceipt)
    expect((await db.query<{ kind: string }>('select line_kind kind from app_private.sale_items where sale_id=$1', [oldReceipt.id])).rows[0].kind).toBe('product')
  })

  test('legacy amount-only registration accepts duplicate concepts and snapshots the configured IVA', async () => {
    const owner = await actor(false)
    await tax(owner, 'border_8')
    const command = { command: 'complete_sale', operationId: randomUUID(), paymentMethod: 'cash', totalCents: 2002, items: [amount(), amount()] }
    const sale = await pos<Sale>(owner, command)
    expect(sale.items).toEqual([expect.objectContaining({ kind: 'amount', productId: null, name: 'Importe libre', taxTreatment: 'border_8', taxBps: 800, taxCents: 74 }), expect.objectContaining({ kind: 'amount', productId: null, name: 'Importe libre', taxCents: 74 })])
    expect((await db.query<{ count: number }>('select count(*)::int count from app_private.products where business_id=$1', [owner.businessId])).rows[0].count).toBe(0)
    await tax(owner, 'exempt')
    expect(await pos(owner, command)).toEqual(sale)
    await expect(pos(owner, { ...command, items: [amount(1001, 'Otro concepto'), amount()] })).rejects.toThrow('OPERATION_CONFLICT')
    await expect(db.query("update app_private.sale_items set name='Alterado' where sale_id=$1", [sale.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
  })

  test('counter amount pays once without kitchen work and retains concept on receipts and refunds', async () => {
    const owner = await actor(), input = orderAmount(11600, 'Servicio sintético')
    let order = await save(owner, [input])
    expect(order.items[0]).toMatchObject({ kind: 'amount', productId: null, name: 'Servicio sintético', version: 1, sentQuantity: 0, taxTreatment: 'vat_16', taxCents: 1600 })
    const paid = await pay(owner, order)
    order = paid.order
    expect(order).toMatchObject({ status: 'closed', balanceCents: 0, paidCents: 11600 })
    const sale = await pos<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId })
    expect(sale.items[0]).toMatchObject({ kind: 'amount', productId: null, name: 'Servicio sintético', taxCents: 1600 })
    expect(await kitchenCount(owner)).toBe(0)
    const reversal = await pos<CheckoutAttempt>(owner, { command: 'prepare_reversal', operationId: randomUUID(), saleId: sale.id, reason: 'Devolución sintética' })
    const started = await pos<CheckoutAttempt>(owner, { command: 'start_checkout', operationId: randomUUID(), attemptId: reversal.id, expectedRevision: reversal.revision })
    await pos(owner, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: started.id, expectedRevision: started.revision, resolution: 'complete', confirmed: true, reason: 'Devuelto' })
    for (const command of ['report_period', 'report_own_period']) {
      const report = await pos<BusinessPeriodReport>(owner, { command, period: 'day', date: today() })
      expect(report.totals).toMatchObject({ salesCents: 11600, reversalCents: 11600, netCents: 0 })
      expect(report.totals.products).toEqual([expect.objectContaining({ kind: 'amount', productId: null, name: 'Importe libre', salesCents: 11600, reversalCents: 11600, netCents: 0 })])
    }
  })

  test('mixed service edits preserve IVA snapshots and send only products, including unpaid cancellation', async () => {
    const owner = await actor(), product = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001 })
    const productLine = { lineId: randomUUID(), productId: product.id, version: product.version, quantity: 1, unitPriceCents: product.priceCents, note: '' }
    const freeLine = orderAmount(1001, 'Cargo original')
    let order = await save(owner, [productLine, freeLine], 'service')
    order = await pos(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
    await tax(owner, 'unconfigured')
    order = await pos(owner, { command: 'save_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, orderKind: 'service', name: order.name, tableId: null, items: [productLine, { ...freeLine, name: 'Cargo editado', unitPriceCents: 23200, quantity: 2 }] })
    expect(order.items.find(line => line.kind === 'amount')).toMatchObject({ name: 'Cargo editado', quantity: 2, sentQuantity: 0, taxTreatment: 'vat_16', taxCents: 6400 })
    expect((await db.query<{ items: unknown }>('select items from app_private.kitchen_batches where business_id=$1', [owner.businessId])).rows[0].items).toEqual([expect.objectContaining({ lineId: productLine.lineId, quantity: 1 })])
    await pos(owner, { command: 'cancel_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: 'Cancelación sintética' })
    const batches = (await db.query<{ items: { lineId: string }[] }>('select items from app_private.kitchen_batches where business_id=$1', [owner.businessId])).rows
    expect(batches.every(batch => batch.items.every(line => line.lineId !== freeLine.lineId))).toBe(true)
  })

  test('monetary parts conserve every discount and IVA cent and do not enqueue amount lines', async () => {
    const owner = await actor(), input = orderAmount(76068, 'Parte libre')
    let order = await save(owner, [input])
    order = await pos(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'fixed', value: 68, reason: 'Ajuste sintético' } })
    const expectedTax = order.taxCents
    const first = await pay(owner, order, [50000, 26000])
    expect(first.order).toMatchObject({ paidCents: 50000, balanceCents: 26000 })
    expect(first.attempt.items[0]).toMatchObject({ kind: 'amount', quantity: 0 })
    const second = await pay(owner, first.order, [26000])
    expect(second.order).toMatchObject({ status: 'closed', balanceCents: 0, paidCents: 76000 })
    expect(first.attempt.taxCents + second.attempt.taxCents).toBe(expectedTax)
    expect(first.attempt.discountCents + second.attempt.discountCents).toBe(68)
    expect(await kitchenCount(owner)).toBe(0)
    expect((await report(owner)).totals.products).toEqual([expect.objectContaining({ kind: 'amount', productId: null, quantity: 1, salesCents: 76000, taxCents: expectedTax })])
    await ledger()
  })

  test('unknown IVA stays unconfigured and the server rejects forged origin fields and invalid amount bounds atomically', async () => {
    const owner = await actor()
    await tax(owner, 'unconfigured')
    const line = orderAmount(), order = await save(owner, [line])
    expect(order.items[0]).toMatchObject({ taxTreatment: 'unconfigured', taxBps: 0, taxCents: 0 })
    for (const patch of [{ productId: randomUUID() }, { version: 1 }, { selection: null }, { note: 'A cocina' }, { taxBps: 1600 }, { unitPriceCents: 0 }, { unitPriceCents: 0.1 }, { unitPriceCents: 100000000 }, { quantity: 1000 }, { name: 'x'.repeat(101) }])
      await expect(save(owner, [{ ...line, ...patch, lineId: randomUUID() } as OrderInputLine])).rejects.toThrow('VALIDATION_ERROR')
    await expect(save(owner, [orderAmount(99_999_999, '', 999)])).rejects.toThrow('VALIDATION_ERROR')
    expect((await db.query<{ count: number }>('select count(*)::int count from app_private.operational_orders where business_id=$1', [owner.businessId])).rows[0].count).toBe(1)
    const other = await actor()
    await expect(pos(other, { command: 'order', orderId: order.id })).rejects.toThrow('ORDER_NOT_FOUND')
    await db.query('delete from auth.sessions where id=$1', [owner.sessionId])
    await expect(pos(owner, { command: 'order', orderId: order.id })).rejects.toThrow('AUTH_REQUIRED')
  })

  test('verified Point materialization pays amount-only snapshots once without preparation', async () => {
    const owner = await actor(), order = await save(owner, [orderAmount(11600, 'Terminal libre')])
    const connection = await service<{ id: string }>('connection_save', { businessId: owner.businessId, environment: 'sandbox', receiverId: randomUUID(), tokensCiphertext: 'synthetic-ciphertext', expiresAt: '2099-01-01T00:00:00Z' })
    const terminalId = `SYNTHETIC-${randomUUID()}`
    await service('terminal_save', { connectionId: connection.id, terminalId, serial: terminalId, storeId: 'STORE', posId: 'POS', mode: 'PDV', verified: true, physicallyConfirmed: true })
    await point(owner, { command: 'activate', enabled: true })
    const reservation = await pos<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'card_integrated' })
    const checkout = await point<PointCheckout>(owner, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: reservation.id, terminalId })
    const started = await point<PointCheckout>(owner, { command: 'start', operationId: randomUUID(), checkoutId: checkout.id })
    const row = (await db.query<{ receiver_id: string; external_reference: string }>('select receiver_id,external_reference from app_private.point_attempts where id=$1', [started.attemptId])).rows[0]
    const facts = { attemptId: started.attemptId, remoteOrderId: `ORDER-${started.attemptId}`, amountCents: 11600, receiverId: row.receiver_id, environment: 'sandbox', externalReference: row.external_reference, currency: 'MXN', observedAt: new Date().toISOString(), refunds: [] }
    await service('apply_order', { ...facts, state: 'unknown_review' })
    expect(await pos(owner, { command: 'order', orderId: order.id })).toMatchObject({ paidCents: 0, balanceCents: 11600 })
    await service('apply_order', { ...facts, state: 'approved_verified' })
    await service('apply_order', { ...facts, state: 'approved_verified' })
    const receipt = await point<PointCheckout>(owner, { command: 'status', checkoutId: checkout.id })
    expect(receipt.sale?.items[0]).toMatchObject({ kind: 'amount', productId: null, name: 'Terminal libre', taxCents: 1600 })
    expect(await kitchenCount(owner)).toBe(0)
    expect(await pos(owner, { command: 'order', orderId: order.id })).toMatchObject({ paidCents: 11600, balanceCents: 0, status: 'closed' })
    await ledger()
  })

  test('private amount helpers and financial tables stay unavailable to browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['app_private.ops_amount_name(jsonb)', 'app_private.ops_amount_vat(jsonb)', 'app_private.ops_line_json_before_free_amount(app_private.order_lines)'])
        expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'app_private.order_lines','SELECT') allowed", [role])).rows[0].allowed).toBe(false)
    }
  })

  test('amount-only commands retain cashier and service grants, including authorization of accepted retries', async () => {
    const owner = await actor()
    const cashier = await staff(owner, ['catalog.read', 'sales.create'])
    const waiter = await staff(owner, ['orders.read', 'orders.manage'])
    const command = { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind: 'counter', name: 'Cobro de cajero', tableId: null, items: [orderAmount()] }
    const counter = await pos<OperationalOrder>(cashier, command)
    expect(counter).toMatchObject({ orderKind: 'counter', items: [{ kind: 'amount', productId: null }] })
    await expect(pos(cashier, { ...command, operationId: randomUUID(), orderId: randomUUID(), orderKind: 'service' })).rejects.toThrow('PERMISSION_DENIED')
    const serviceOrder = await save(waiter, [orderAmount()], 'service')
    await expect(pos(waiter, { command: 'prepare_checkout', operationId: randomUUID(), orderId: serviceOrder.id, expectedRevision: serviceOrder.revision, items: [{ lineId: serviceOrder.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })).rejects.toThrow('PERMISSION_DENIED')
    await expect(pos(waiter, { command: 'complete_sale', operationId: randomUUID(), paymentMethod: 'cash', totalCents: 1001, items: [amount()] })).rejects.toThrow('PERMISSION_DENIED')
    expect((await pay(cashier, counter)).order.balanceCents).toBe(0)
    expect(await pos(cashier, command)).toEqual(counter)
    expect((await db.query<{ count: number }>('select count(*)::int count from app_private.products where business_id=$1', [owner.businessId])).rows[0].count).toBe(0)
    await db.query('update app_private.employees set permissions=$1 where id=$2', [[], cashier.employeeId])
    await expect(pos(cashier, command)).rejects.toThrow('SESSION_INVALID')
    await renewStaff(cashier)
    await expect(pos(cashier, command)).rejects.toThrow('PERMISSION_DENIED')
    expect(await kitchenCount(owner)).toBe(0)
  })
})

async function actor(activate = true): Promise<Actor> {
  const value = { businessId: randomUUID(), userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [value.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId])
  await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash","transfer","card_integrated"],"accountsEnabled":true,"defaultVatTreatment":"vat_16"}')`, [value.businessId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [value.businessId, value.userId])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Persona sintética','owner')", [value.employeeId, value.businessId, value.userId])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [value.businessId, value.userId, value.sessionId, value.token])
  if (activate) { await pos(value, { command: 'activate_operations', operationId: randomUUID() }); await pos(value, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }) }
  return value
}
async function staff(owner: Actor, permissions: string[]): Promise<Actor> {
  const value = { businessId: owner.businessId, userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: '', keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [value.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'cashier')", [value.businessId, value.userId])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Personal sintético','cashier',$4)", [value.employeeId, value.businessId, value.userId, permissions])
  await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [value.businessId, value.employeeId, value.keyHash])
  await renewStaff(value)
  return value
}
async function renewStaff(value: Actor) {
  value.token = randomUUID().replaceAll('-', '').repeat(2)
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [value.businessId, value.userId, value.sessionId, value.token, value.keyHash])
}
async function pos<T = unknown>(value: Actor, command: object): Promise<T> {
  const result = value.keyHash
    ? (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [value.userId, value.sessionId, JSON.stringify({ action: 'pos', businessId: value.businessId, operatorToken: value.token, ...command }), value.keyHash, randomUUID()])).rows[0].result
    : (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.pos_execute($1,$2,$3,$4,$5::jsonb) result', [value.userId, value.sessionId, value.businessId, value.token, JSON.stringify(command)])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
async function point<T = unknown>(value: Actor, command: object): Promise<T> { return (await db.query<{ result: { data: T } }>("select public.account_secure($1,$2,'point',$3::jsonb) result", [value.userId, value.sessionId, JSON.stringify({ action: 'point', businessId: value.businessId, operatorToken: value.token, ...command })])).rows[0].result.data }
async function service<T = unknown>(action: string, payload: object): Promise<T> { return (await db.query<{ result: T }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result }
function save(value: Actor, items: OrderInputLine[], orderKind: 'counter' | 'service' = 'counter') { return pos<OperationalOrder>(value, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind, name: 'Cuenta sintética', tableId: null, items }) }
async function pay(value: Actor, order: OperationalOrder, amountsCents?: number[]) {
  const reservation = await pos<CheckoutAttempt>(value, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: amountsCents ? [] : order.items.map(line => ({ lineId: line.lineId, quantity: line.quantity - line.paidQuantity })), ...(amountsCents ? { amountsCents } : {}), paymentMethod: 'cash' })
  const command = { command: 'record_checkout', operationId: randomUUID(), attemptId: reservation.id, expectedRevision: reservation.revision, confirmed: true }
  const receipt = await pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(value, command)
  expect(await pos(value, command)).toEqual(receipt)
  return receipt
}
function tax(value: Actor, treatment: string) { return db.query("update app_private.businesses set profile=profile||jsonb_build_object('defaultVatTreatment',$2::text) where id=$1", [value.businessId, treatment]) }
function kitchenCount(value: Actor) { return db.query<{ count: number }>('select count(*)::int count from app_private.kitchen_batches where business_id=$1', [value.businessId]).then(result => result.rows[0].count) }
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
function report(value: Actor) { return pos<BusinessPeriodReport>(value, { command: 'report_period', period: 'day', date: today() }) }
async function ledger() { expect(Object.values((await db.query<{ result: Record<string, number> }>('select app_private.ops_financial_ledger_check() result')).rows[0].result).every(value => value === 0)).toBe(true) }
