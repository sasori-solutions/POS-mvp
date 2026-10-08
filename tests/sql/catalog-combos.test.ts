import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { emptyDetails, includedTax, selectedPrice } from '../../src/lib/product-details'
import type { PosCommand, Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
import type { PointCheckout } from '../../src/lib/point-contracts'
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
type SaveProduct = Extract<PosCommand, { command: 'save_product' }>
let db: PGlite
describe('fixed combo preparation snapshots', () => {
 beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && (file <= '20261007130000_modifier_selection.sql' || file === '20261007170000_nested_modifiers.sql' || file === '20261007180000_catalog_combos.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
 }, 90_000)
 afterAll(async () => { await db?.close() })

 it('validates typed canonical components, same tenant, versions, availability and rejects recursive/self combos', async () => {
  const owner = await actor(), foreign = await actor(), child = await execute<Product>(owner, saveProduct()), outsider = await execute<Product>(foreign, saveProduct())
  const details = { ...emptyDetails(), comboComponents: [{ productId: child.id, version: child.version, quantity: 2 }] }
  const command = saveProduct(details, 5001), combo = await execute<Product>(owner, command)
  expect(combo.comboComponents).toEqual([{ productId: child.id, version: 1, quantity: 2, name: child.name, kitchenName: child.name, selectionLabel: '' }])
  expect(combo.priceCents).toBe(5001)
  expect(selectedPrice(combo)).toBe(5001)
  for (const patch of [
   { comboComponents: [{ ...details.comboComponents[0], quantity: 0 }] },
   { comboComponents: [{ ...details.comboComponents[0], extra: true }] },
   { variablePrice: true }, { comboComponents: [...details.comboComponents, ...details.comboComponents] },
  ]) {
   const invalid = saveProduct({ ...details, ...patch })
   expect(() => parse(owner, invalid)).toThrow()
   await expect(executeRaw(owner, invalid)).rejects.toThrow('VALIDATION_ERROR')
  }
  await expect(execute(owner, saveProduct({ ...details, comboComponents: [{ productId: outsider.id, version: 1, quantity: 1 }] }))).rejects.toThrow('PRODUCT_CHANGED')
  await expect(execute(owner, saveProduct({ ...details, comboComponents: [{ productId: child.id, version: 2, quantity: 1 }] }))).rejects.toThrow('PRODUCT_CHANGED')
  await expect(execute(owner, saveProduct({ ...details, comboComponents: [{ productId: combo.id, version: combo.version, quantity: 1 }] }))).rejects.toThrow('PRODUCT_UNAVAILABLE')
  await expect(execute(owner, { ...saveProduct(details), productId: child.id, expectedVersion: child.version })).rejects.toThrow('VALIDATION_ERROR')
  expect(await execute(owner, command)).toEqual(combo)
  for (const role of ['anon', 'authenticated']) {
   const access = (await db.query<{ allowed: boolean }>("select bool_or(has_function_privilege($1,p.oid,'execute')) allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in ('validate_combo_input','combo_availability_reason','capture_combo_product_snapshot','capture_combo_order_snapshot','capture_combo_kitchen_snapshot','capture_combo_legacy_receipt_snapshot')", [role])).rows[0]
   expect(access.allowed).toBe(false)
  }
 })

 it('retains component snapshots after component edits and availability changes through service, KDS, split VAT and immutable receipts', async () => {
  const owner = await actor(), shot = randomUUID()
  const child = await execute<Product>(owner, saveProduct({ ...emptyDetails(), customerName: 'Café público', kitchenName: 'CAFE BARRA', modifierSets: [{ id: randomUUID(), name: 'Extra', min: 1, max: 2, options: [{ id: shot, name: 'Shot', priceCents: 101, maxQuantity: 2 }] }] }))
  const componentSelection = { variationId: null, modifierIds: [shot, shot], variablePriceCents: null }
  const combo = await execute<Product>(owner, saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, comboComponents: [{ productId: child.id, version: child.version, quantity: 2, selection: componentSelection }] }, 5001))
  await execute(owner, { command: 'activate_operations', operationId: randomUUID() }); await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const command = { ...newOrder(combo), items: [{ ...newOrder(combo).items[0], quantity: 2 }] }
  let order = await execute<OperationalOrder>(owner, command)
  expect(order.items[0].comboComponents).toEqual(combo.comboComponents)
  const editedChild = await execute<Product>(owner, { ...saveProduct({ ...child.details!, customerName: 'Nombre posterior', kitchenName: 'BARRA NUEVA' }, 99999), productId: child.id, expectedVersion: child.version })
  const catalog = (await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products
  expect(catalog.find(product => product.id === combo.id)?.comboComponents).toEqual(combo.comboComponents)
  expect(catalog.find(product => product.id === combo.id)?.comboUnavailableReason).toBeNull()
  const unchanged = await execute<Product>(owner, { ...saveProduct(combo.details!, combo.priceCents), productId: combo.id, expectedVersion: combo.version, category: 'Combos' })
  expect(unchanged.comboComponents).toEqual(combo.comboComponents)
  await execute(owner, { command: 'set_product_sold_out', operationId: randomUUID(), productId: child.id, expectedVersion: editedChild.version, soldOut: true })
  expect(await execute(owner, command)).toEqual(order)
  await expect(execute(owner, newOrder(unchanged))).rejects.toThrow('PRODUCT_UNAVAILABLE')
  order = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  const batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
  expect(batches.find(batch => batch.orderId === order.id)?.items[0]).toMatchObject({ quantity: 2, comboComponents: combo.comboComponents })
  order = await execute<OperationalOrder>(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'fixed', value: 1, reason: 'Redondeo sintético' } })
  order = await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  const first = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, paymentMethod: 'cash', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })
  const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: first.id, expectedRevision: first.revision, confirmed: true }
  const paid = await execute<{ attempt: CheckoutAttempt; order: OperationalOrder }>(owner, payment)
  expect(await execute(owner, payment)).toEqual(paid)
  const sale = await execute<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! })
  expect(sale.items[0].comboComponents).toEqual(combo.comboComponents)
  const second = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: paid.order.revision, paymentMethod: 'transfer', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })
  expect(first.totalCents+second.totalCents).toBe(10001)
 expect(first.taxCents+second.taxCents).toBe(includedTax(10001,1600))
 })

 it('retains preparation in automatic pay-first batches and independent cancellation notices without duplicating a replay', async () => {
  const owner = await actor(), child = await execute<Product>(owner, saveProduct({ ...emptyDetails(), customerName: 'Pan público', kitchenName: 'PAN BARRA' }))
  const combo = await execute<Product>(owner, saveProduct({ ...emptyDetails(), comboComponents: [{ productId: child.id, version: child.version, quantity: 3 }] }, 1001))
  await execute(owner, { command: 'activate_operations', operationId: randomUUID() }); await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const counter = await execute<OperationalOrder>(owner, { ...newOrder(combo), orderKind: 'counter' })
  expect((await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches).toHaveLength(0)
  const quote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision, paymentMethod: 'cash', items: [{ lineId: counter.items[0].lineId, quantity: 1 }] })
  const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
  const accepted = await execute(owner, payment)
  expect(await execute(owner, payment)).toEqual(accepted)
  let batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
  expect(batches.filter(batch => batch.orderId === counter.id)).toHaveLength(1)
  expect(batches.find(batch => batch.orderId === counter.id)?.items[0]).toMatchObject({ quantity: 1, comboComponents: combo.comboComponents })
  let account = await execute<OperationalOrder>(owner, { ...newOrder(combo), items: [{ ...newOrder(combo).items[0], quantity: 2 }] })
  account = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision })
  const cancel = { command: 'cancel_order' as const, operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, reason: 'Cancelación sintética' }
  const cancelled = await execute(owner, cancel)
  expect(await execute(owner, cancel)).toEqual(cancelled)
  batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
  const notice = batches.find(batch => batch.orderId === account.id && batch.kind === 'cancellation')!
  expect(notice.items[0]).toMatchObject({ quantity: 2, comboComponents: combo.comboComponents })
  expect(batches.filter(batch => batch.orderId === account.id && batch.kind === 'cancellation')).toHaveLength(1)
  const acknowledged = await execute<KitchenBatch>(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: notice.id, expectedRevision: notice.revision, status: 'delivered' })
  expect(acknowledged).toMatchObject({ status: 'delivered', items: [expect.objectContaining({ comboComponents: combo.comboComponents })] })
 })

 it('materializes verified Point payment from immutable combo quotes after catalog mutation and repeated provider evidence', async () => {
  const owner = await actor(), child = await execute<Product>(owner, saveProduct({ ...emptyDetails(), customerName: 'Café original', kitchenName: 'CAFE BARRA' }))
  const combo = await execute<Product>(owner, saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, comboComponents: [{ productId: child.id, version: child.version, quantity: 2 }] }, 1001))
  await execute(owner, { command: 'activate_operations', operationId: randomUUID() }); await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const connection = await service<{ id: string }>('connection_save', { businessId: owner.businessId, environment: 'live', receiverId: randomUUID(), tokensCiphertext: 'encrypted-synthetic-tokens', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const terminalId = `SYNTHETIC-${randomUUID()}`
  await service('terminal_save', { connectionId: connection.id, terminalId, serial: terminalId, storeId: 'STORE-1', posId: 'POS-1', mode: 'PDV', verified: true, physicallyConfirmed: true })
  await point(owner, { command: 'activate', enabled: true })
  const order = await execute<OperationalOrder>(owner, { ...newOrder(combo), orderKind: 'counter' })
  const quote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, paymentMethod: 'card_integrated', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })
  const prepared = await point<PointCheckout>(owner, { command: 'prepare', operationId: randomUUID(), checkoutAttemptId: quote.id, terminalId })
  const started = await point<PointCheckout>(owner, { command: 'start', operationId: randomUUID(), checkoutId: prepared.id })
  await execute(owner, { ...saveProduct({ ...child.details!, customerName: 'Cambio posterior', kitchenName: 'BARRA NUEVA' }, 99999), productId: child.id, expectedVersion: child.version })
  const facts = (await db.query<{ amount_cents: number; receiver_id: string; environment: string; external_reference: string }>('select amount_cents::integer,receiver_id,environment,external_reference from app_private.point_attempts where id=$1', [started.attemptId!])).rows[0]
  const evidence = { attemptId: started.attemptId, remoteOrderId: `ORDER-${started.attemptId}`, amountCents: facts.amount_cents, receiverId: facts.receiver_id, environment: facts.environment, externalReference: facts.external_reference, currency: 'MXN', observedAt: new Date().toISOString(), refunds: [], state: 'approved_verified' }
  await service('apply_order', evidence); await service('apply_order', evidence)
  const paid = await point<PointCheckout>(owner, { command: 'status', checkoutId: prepared.id })
  expect(paid).toMatchObject({ saleState: 'materialized', sale: { totalCents: 1001, items: [expect.objectContaining({ comboComponents: combo.comboComponents, taxCents: includedTax(1001,1600) })] } })
  expect((await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches.filter(batch => batch.orderId === order.id)).toEqual([expect.objectContaining({ items: [expect.objectContaining({ comboComponents: combo.comboComponents })] })])
  expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.sales where business_id=$1', [owner.businessId])).rows[0].count).toBe(1)
  const ledger = (await db.query<{ result: Record<string, number> }>('select app_private.ops_financial_ledger_check() result')).rows[0].result
  expect(Object.values(ledger).every(value => value === 0)).toBe(true)
 })

 it('keeps direct-sale receipts compatible and snapshots fixed component quantities without repricing', async () => {
  const owner = await actor(), child = await execute<Product>(owner, saveProduct())
  const combo = await execute<Product>(owner, saveProduct({ ...emptyDetails(), comboComponents: [{ productId: child.id, version: child.version, quantity: 3 }] }, 101))
  const command = { command: 'complete_sale' as const, operationId: randomUUID(), paymentMethod: 'cash' as const, totalCents: 202, items: [{ productId: combo.id, version: combo.version, quantity: 2, unitPriceCents: 101 }] }
  const sale = await execute<Sale>(owner, command)
  expect(sale.items[0].comboComponents).toEqual(combo.comboComponents)
  expect(sale.totalCents).toBe(202)
  expect(await execute(owner, command)).toEqual(sale)
 })
})

function saveProduct(details: ProductDetails = emptyDetails(), priceCents = 11600): SaveProduct {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Latte sintético', category: 'Café', priceCents, details }
}

function newOrder(product: Product): Extract<PosCommand, { command: 'save_order' }> {
  return {
    command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null,
    name: 'Cuenta sintética', tableId: null, orderKind: 'service',
    items: [{ lineId: randomUUID(), productId: product.id, quantity: 1, unitPriceCents: product.priceCents, version: product.version, note: '' }],
  }
}

function envelope(current: Actor, command: PosCommand) {
  return { action: 'pos', businessId: current.businessId, operatorToken: current.token, ...command }
}

function parse(current: Actor, command: PosCommand) {
  return parseAccountRequest(envelope(current, command))
}

async function execute<T = unknown>(current: Actor, command: PosCommand): Promise<T> {
  parse(current, command)
  return executeRaw<T>(current, command)
}

async function executeRaw<T = unknown>(current: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>(
    "select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result",
    [current.userId, current.sessionId, JSON.stringify(envelope(current, command)), current.keyHash, randomUUID()],
  )).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}

async function point<T = unknown>(current: Actor, command: Record<string, unknown>): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>(
    "select public.account_secure($1,$2,'point',$3::jsonb,$4,$5) result",
    [current.userId, current.sessionId, JSON.stringify({ action: 'point', businessId: current.businessId, operatorToken: current.token, ...command }), current.keyHash, randomUUID()],
  )).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}

async function service<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  return (await db.query<{ result: T }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result
}

async function actor(existingBusiness?: string, permissions: string[] = []): Promise<Actor> {
  const role = existingBusiness ? 'cashier' : 'owner'
  const current = {
    userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(),
    token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2),
  }
  await db.query('insert into auth.users(id) values($1)', [current.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [current.sessionId, current.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile)
    values($1,'Café sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","accountsEnabled":true,"paymentMethods":["cash","card_external","transfer"]}')`, [current.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [current.businessId, current.userId, role])
  await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,$4,$5,$6)', [current.employeeId, current.businessId, current.userId, 'Operador sintético', role, permissions])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash)
    values($1,$2,$3,extensions.digest($4,'sha256'))`, [current.businessId, current.userId, current.sessionId, current.token])
  if (existingBusiness) {
    await db.query(`insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name)
      values($1,$2,decode($3,'hex'),'Navegador sintético')`, [current.businessId, current.employeeId, current.keyHash])
    await db.query("update app_private.operator_sessions set employee_device_key_hash=decode($1,'hex') where business_id=$2 and user_id=$3", [current.keyHash, current.businessId, current.userId])
  }
  return current
}
