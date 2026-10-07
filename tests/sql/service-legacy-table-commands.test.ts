import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, DiningTable, OperationalOrder } from '../../src/lib/operations-contracts'
import type { ServiceOrderState, ServiceReservation, ServiceResponses } from '../../src/lib/service-contracts'

type Actor = { businessId: string; userId: string; sessionId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite

describe('legacy table commands on the complete service migration chain', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  test('does not create service visits for nullable legacy counter quotes or explicit counter orders', async () => {
    const owner = await actor(), cashier = await actor(owner.businessId, ['catalog.read', 'sales.create', 'sales.read_own'])
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
    for (const orderKind of ['legacy', 'counter'] as const) {
      const order = await account(owner, 1, null, orderKind, cashier)
      const quote = await execute<CheckoutAttempt>(cashier, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
      expect((await db.query('select * from app_private.service_visit_orders where business_id=$1 and order_id=$2', [owner.businessId, order.id])).rows).toHaveLength(0)
      await execute(cashier, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
      expect((await db.query('select * from app_private.service_visit_orders where business_id=$1 and order_id=$2', [owner.businessId, order.id])).rows).toHaveLength(0)
    }
  })

  test('moves one partially paid visit atomically, keeps sale snapshots and original payment replay, and invalidates stale visit edits', async () => {
    const owner = await actor(), from = await table(owner), to = await table(owner)
    const paid = await pay(owner, await account(owner, 2, from.id), 1)
    const before = await state(owner, paid.order), receipts = await sales(owner)
    const command = { command: 'move_order' as const, operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, tableId: to.id }
    const moved = await execute<OperationalOrder>(owner, command)
    const after = await state(owner, moved)
    expect(moved).toMatchObject({ tableId: to.id, frozen: true, paidCents: 1001, balanceCents: 1001 })
    expect(after.visit).toMatchObject({ id: before.visit!.id, status: 'active', revision: before.visit!.revision + 1, tableIds: [to.id], balanceCents: 1001, orders: [expect.objectContaining({ id: moved.id })] })
    expect(await sales(owner)).toEqual(receipts)
    expect(await execute(owner, paid.command)).toEqual(paid.result)
    expect(await execute(owner, command)).toEqual(moved)
    const tables = (await execute<{ tables: DiningTable[] }>(owner, { command: 'tables' })).tables
    expect(tables.find(t => t.id === from.id)).toMatchObject({ orderId: null, visitId: null })
    expect(tables.find(t => t.id === to.id)).toMatchObject({ orderId: moved.id, visitId: before.visit!.id })
    await expect(execute(owner, { command: 'associate_service_tables', operationId: randomUUID(), orderId: moved.id, expectedRevision: moved.revision, expectedVisitRevision: before.visit!.revision, tableIds: [from.id] })).rejects.toThrow('VISIT_CHANGED')
    await expect(execute(owner, { command: 'close_order', operationId: randomUUID(), orderId: moved.id, expectedRevision: moved.revision })).rejects.toThrow('ORDER_LOCKED')
  })

  test('nested payment closes keep tables occupied; explicit close finalizes one-account visit and accepted replay cannot free its replacement', async () => {
    const owner = await actor(), seat = await table(owner)
    const paid = await pay(owner, await account(owner, 1, seat.id))
    expect(paid.order.status).toBe('closed')
    const before = await state(owner, paid.order), receipts = await sales(owner)
    expect(before.visit).toMatchObject({ status: 'active', tableIds: [seat.id], balanceCents: 0 })
    await expect(account(owner, 1, seat.id)).rejects.toThrow('TABLE_OCCUPIED')
    const command = { command: 'close_order' as const, operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision }
    const closed = await execute<OperationalOrder>(owner, command)
    expect((await state(owner, closed)).visit).toMatchObject({ status: 'closed', tableIds: [], revision: before.visit!.revision + 1 })
    expect(await sales(owner)).toEqual(receipts)
    const replacement = await account(owner, 1, seat.id)
    const linked = await execute<ServiceResponses['associate_service_tables']>(owner, { command: 'associate_service_tables', operationId: randomUUID(), orderId: replacement.id, expectedRevision: replacement.revision, expectedVisitRevision: null, tableIds: [seat.id] })
    expect(await execute(owner, command)).toEqual(closed)
    expect((await state(owner, linked.order)).visit).toMatchObject({ id: linked.visit.id, status: 'active', tableIds: [seat.id], balanceCents: 1001 })
    expect(await execute(owner, paid.command)).toEqual(paid.result)
    await expect(execute(owner, { ...command, operationId: randomUUID(), expectedRevision: closed.revision })).rejects.toThrow('ORDER_LOCKED')
  })

  test('one legacy account cannot move or close a multi-account visit, with debt or after every balance is settled', async () => {
    const owner = await actor(), seat = await table(owner), destination = await table(owner)
    const paid = await pay(owner, await account(owner, 1, seat.id))
    const linked = await execute<ServiceResponses['continue_service_order']>(owner, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: paid.order.id, expectedRevision: paid.order.revision, orderId: randomUUID(), name: 'Consumo siguiente' })
    const item = paid.order.items[0]
    let newer = await execute<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: linked.order.id, expectedRevision: linked.order.revision, orderKind: 'service', name: linked.order.name, tableId: null, items: [{ lineId: randomUUID(), productId: item.productId!, version: item.version, unitPriceCents: item.unitPriceCents, quantity: 1, note: '' }] })
    for (const settled of [false, true]) {
      if (settled) newer = (await pay(owner, newer)).order
      const before = await state(owner, paid.order), receipts = await sales(owner)
      for (const tableId of [destination.id, null]) await expect(execute(owner, { command: 'move_order', operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, tableId })).rejects.toThrow('VISIT_CHANGED')
      await expect(execute(owner, { command: 'close_order', operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision })).rejects.toThrow('VISIT_CHANGED')
      expect(await state(owner, paid.order)).toEqual(before)
      expect(await sales(owner)).toEqual(receipts)
    }
    const ready = (await state(owner, newer)).visit!
    const released = await execute<ServiceResponses['release_service_visit']>(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: ready.id, expectedRevision: ready.revision })
    expect(released).toMatchObject({ status: 'closed', tableIds: [], balanceCents: 0, orders: [expect.anything(), expect.anything()] })
  })

  test('rejects occupied and foreign destinations without changing any claim, revision or immutable receipt', async () => {
    const owner = await actor(), outsider = await actor(), from = await table(owner), occupied = await table(owner), foreign = await table(outsider)
    const paid = await pay(owner, await account(owner, 2, from.id), 1)
    const occupant = await pay(owner, await account(owner, 1, occupied.id))
    expect(occupant.order.status).toBe('closed')
    const before = await state(owner, paid.order), receipts = await sales(owner)
    for (const [tableId, error] of [[occupied.id, 'TABLE_OCCUPIED'], [foreign.id, 'TABLE_CHANGED']] as const) {
      await expect(execute(owner, { command: 'move_order', operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, tableId })).rejects.toThrow(error)
      expect(await state(owner, paid.order)).toEqual(before)
      expect(await sales(owner)).toEqual(receipts)
    }
    const moved = await execute<OperationalOrder>(owner, { command: 'move_order', operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, tableId: null })
    expect((await state(owner, moved)).visit).toMatchObject({ status: 'active', tableIds: [], balanceCents: 1001 })
    expect(await account(owner, 1, from.id)).toMatchObject({ tableId: from.id })
  })

  test('revalidates the live actor before accepted move and close replays', async () => {
    const owner = await actor(), seat = await table(owner), destination = await table(owner)
    const order = (await pay(owner, await account(owner, 1, seat.id))).order
    const mover = await actor(owner.businessId, ['orders.read', 'tables.manage'])
    const move = { command: 'move_order' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, tableId: destination.id }
    const moved = await execute<OperationalOrder>(mover, move)
    const closer = await actor(owner.businessId, ['orders.read', 'tables.manage'])
    const close = { command: 'close_order' as const, operationId: randomUUID(), orderId: moved.id, expectedRevision: moved.revision }
    const closed = await execute<OperationalOrder>(closer, close)
    expect(await execute(mover, move)).toEqual(moved)
    expect(await execute(closer, close)).toEqual(closed)
    await db.query('update app_private.employees set permissions=$2 where id=$1', [mover.employeeId, ['orders.read']])
    await expect(execute(mover, move)).rejects.toThrow('SESSION_INVALID')
    await db.query('update app_private.employees set active=false where id=$1', [closer.employeeId])
    await expect(execute(closer, close)).rejects.toThrow()
    expect((await state(owner, closed)).visit).toMatchObject({ status: 'closed', tableIds: [] })
    const privilege = (await db.query<{ executable: boolean }>("select has_function_privilege('authenticated','app_private.pos_command_before_service_legacy_tables(uuid,uuid,jsonb)','EXECUTE') or has_function_privilege('authenticated','app_private.service_legacy_close_guard()','EXECUTE') executable")).rows[0]
    expect(privilege.executable).toBe(false)
  })

  test('explicit legacy close completes a seated reservation while an automatic payment close keeps it seated', async () => {
    const owner = await actor(), seat = await table(owner), order = await account(owner, 1)
    const reservation = await execute<ServiceReservation>(owner, { command: 'save_service_reservation', operationId: randomUUID(), reservationId: randomUUID(), expectedRevision: null, name: 'Reserva sintética', contact: '', partySize: 2, startsAt: '2026-10-09T18:00:00Z', endsAt: '2026-10-09T19:00:00Z', tableIds: [seat.id], note: '' })
    const seated = await execute<ServiceResponses['set_service_reservation_status']>(owner, { command: 'set_service_reservation_status', operationId: randomUUID(), reservationId: reservation.id, expectedRevision: reservation.revision, status: 'seated', orderId: order.id })
    const paid = await pay(owner, await execute<OperationalOrder>(owner, { command: 'order', orderId: order.id }))
    expect((await db.query<{ status: string }>('select status from app_private.service_reservations where business_id=$1 and id=$2', [owner.businessId, reservation.id])).rows[0].status).toBe('seated')
    const close = { command: 'close_order' as const, operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision }
    await execute(owner, close)
    const after = (await db.query<{ status: string; revision: number }>('select status,revision from app_private.service_reservations where business_id=$1 and id=$2', [owner.businessId, reservation.id])).rows[0]
    expect(after).toEqual({ status: 'completed', revision: seated.reservation.revision + 1 })
    await execute(owner, close)
    expect((await db.query('select status,revision from app_private.service_reservations where business_id=$1 and id=$2', [owner.businessId, reservation.id])).rows[0]).toEqual(after)
  })
})

async function actor(businessId?: string, permissions: string[] = []): Promise<Actor> {
  const value = { businessId: businessId ?? randomUUID(), userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }, role = businessId ? 'cashier' : 'owner'
  await db.query('insert into auth.users(id) values($1)', [value.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId])
  if (!businessId) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash"],"accountsEnabled":true}')`, [value.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.businessId, value.userId, role])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [value.employeeId, value.businessId, value.userId, role, permissions])
  if (businessId) await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [value.businessId, value.employeeId, value.keyHash])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),case when $5 then decode($6,'hex') else null end)", [value.businessId, value.userId, value.sessionId, value.token, Boolean(businessId), value.keyHash])
  if (!businessId) await execute(value, { command: 'activate_operations', operationId: randomUUID() })
  return value
}

async function execute<T = unknown>(value: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [value.userId, value.sessionId, JSON.stringify({ action: 'pos', businessId: value.businessId, operatorToken: value.token, ...command }), value.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}

async function account(owner: Actor, quantity = 1, tableId: string | null = null, orderKind: 'service' | 'counter' | 'legacy' = 'service', writer = owner) {
  const product = await execute<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001 })
  const command = { command: 'save_order' as const, operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity, note: '' }] }
  return execute<OperationalOrder>(writer, orderKind === 'legacy' ? command : { ...command, orderKind })
}

function table(owner: Actor) { return execute<DiningTable>(owner, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa ' + randomUUID().slice(0, 4), active: true }) }
function state(owner: Actor, order: OperationalOrder) { return execute<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id }) }
async function sales(owner: Actor) { return (await db.query('select * from app_private.sales where business_id=$1 order by id', [owner.businessId])).rows }

async function pay(owner: Actor, original: OperationalOrder, quantity?: number) {
  const open = (await db.query<{ count: number }>("select count(*)::integer count from app_private.cash_shifts where business_id=$1 and status='open'", [owner.businessId])).rows[0].count
  if (!open) await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const order = original.phase === 'checkout' ? original : await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: original.id, expectedRevision: original.revision })
  const quote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: order.items.map(item => ({ lineId: item.lineId, quantity: quantity ?? item.quantity - item.paidQuantity })), paymentMethod: 'cash' })
  const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const }
  const result = await execute<{ order: OperationalOrder; attempt: CheckoutAttempt }>(owner, command)
  return { order: result.order, result, command }
}
