import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { DiningTable, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
import type { ServiceDay, ServiceOrderState, ServiceResponses, ServiceReservation } from '../../src/lib/service-contracts'

type Actor = { businessId: string; userId: string; sessionId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite
describe('restaurant service on the real migration chain', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  test('holds exact quantities, blocks implicit sending/payment, and sends a snapshot once', async () => {
    const owner = await actor(); let order = await account(owner, 3)
    const courseCommand = { command: 'save_service_course' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: randomUUID(), name: 'Entradas', items: [{ lineId: order.items[0].lineId, quantity: 2 }] }
    let state = await execute<ServiceResponses['save_service_course']>(owner, courseCommand); order = state.order
    expect(state.courses).toMatchObject([{ name: 'Entradas', status: 'held', items: [{ quantity: 2 }] }])
    for (const command of ['send_order', 'begin_order_checkout'] as const) await expect(execute(owner, { command, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })).rejects.toThrow('COURSE_HELD')
    await expect(execute(owner, { command: 'cancel_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: 'Error sintético' })).rejects.toThrow('COURSE_HELD')
    const send = { command: 'send_service_course' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: courseCommand.courseId }
    state = await execute(owner, send); order = state.order
    expect(order.items[0]).toMatchObject({ quantity: 3, sentQuantity: 2, paidQuantity: 0 })
    expect(state.courses[0]).toMatchObject({ status: 'sent', batchId: expect.any(String) })
    expect(await execute(owner, send)).toEqual(state)
    const batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
    expect(batches).toHaveLength(1); expect(batches[0].items).toEqual([expect.objectContaining({ quantity: 2, note: 'Sin azúcar', name: 'Café sintético' })])
    await expect(execute(owner, { ...send, operationId: randomUUID(), expectedRevision: order.revision })).rejects.toThrow('COURSE_CHANGED')
    const sentRest = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
    expect(sentRest.items[0].sentQuantity).toBe(3)
    expect((await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches.find(b => b.id !== batches[0].id)?.items[0].quantity).toBe(1)
    expect(await execute(owner, courseCommand)).toEqual(expect.objectContaining({ order: expect.objectContaining({ revision: 2 }) }))
    await expect(execute(owner, { ...courseCommand, name: 'Cambio' })).rejects.toThrow('OPERATION_CONFLICT')
  })

  test('releasing a held group changes neither money nor consumption and preserves sent cancellation traces', async () => {
    const owner = await actor(); let order = await account(owner, 2)
    const command = { command: 'save_service_course' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: randomUUID(), name: 'Postres', items: [{ lineId: order.items[0].lineId, quantity: 2 }] }
    order = (await execute<ServiceResponses['save_service_course']>(owner, command)).order
    const release = await execute<ServiceResponses['cancel_service_course']>(owner, { command: 'cancel_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: command.courseId })
    expect(release.order).toMatchObject({ totalCents: 2002, balanceCents: 2002, items: [expect.objectContaining({ quantity: 2, sentQuantity: 0 })] })
    expect(release.courses[0].status).toBe('released')
    const held = await execute<ServiceResponses['save_service_course']>(owner, { ...command, operationId: randomUUID(), courseId: randomUUID(), expectedRevision: release.order.revision })
    const sent = await execute<ServiceResponses['send_service_course']>(owner, { command: 'send_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: held.order.revision, courseId: held.courses.find(c => c.status === 'held')!.id })
    await execute(owner, { command: 'cancel_order', operationId: randomUUID(), orderId: order.id, expectedRevision: sent.order.revision, reason: 'Error sintético' })
    const kitchen = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
    expect(kitchen.find(b => b.id === sent.courses.find(c => c.status === 'sent')!.batchId)?.fullyCancelled).toBe(true)
    expect(kitchen.some(b => b.kind === 'cancellation')).toBe(true)
  })

  test('reservations conflict atomically on tables, permit adjacent intervals, and retain revision/replay authorization', async () => {
    const owner = await actor(), table = await newTable(owner), outsider = await actor(), reader = await actor(owner.businessId, ['orders.read'])
    const command = reservationCommand(table.id)
    const first = await execute<ServiceReservation>(owner, command)
    await expect(execute(owner, { ...command, operationId: randomUUID(), reservationId: randomUUID(), startsAt: '2026-10-09T19:00:00Z', endsAt: '2026-10-09T20:30:00Z' })).rejects.toThrow('RESERVATION_CONFLICT')
    expect(await execute(owner, { ...command, operationId: randomUUID(), reservationId: randomUUID(), startsAt: command.endsAt, endsAt: '2026-10-09T21:00:00Z' })).toMatchObject({ status: 'confirmed' })
    await expect(execute(outsider, command)).rejects.toThrow('TABLE_CHANGED')
    await expect(execute(reader, { command: 'service_day', date: '2026-10-09' })).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(reader, command)).rejects.toThrow('PERMISSION_DENIED')
    const cancelled = await execute<ServiceResponses['set_service_reservation_status']>(owner, { command: 'set_service_reservation_status', operationId: randomUUID(), reservationId: first.id, expectedRevision: first.revision, status: 'cancelled', orderId: null })
    expect(cancelled.reservation.status).toBe('cancelled'); expect(await execute(owner, command)).toEqual(first)
    await expect(execute(owner, { ...command, operationId: randomUUID(), expectedRevision: first.revision })).rejects.toThrow('RESERVATION_CHANGED')
    expect((await execute<ServiceDay>(owner, { command: 'service_day', date: '2026-10-09' })).reservations).toHaveLength(2)
    const manager = await actor(owner.businessId, ['orders.read', 'orders.manage', 'tables.manage'])
    const accepted = { ...command, operationId: randomUUID(), reservationId: randomUUID(), tableIds: [] }
    await execute(manager, accepted)
    await db.query('update app_private.employees set permissions=$3 where business_id=$1 and id=$2', [owner.businessId, manager.employeeId, []])
    await expect(execute(manager, accepted)).rejects.toThrow()
  })

  test('continuation preserves the paid sale, returns every account and keeps associated tables occupied until release', async () => {
    const owner = await actor(), table = await newTable(owner), table2 = await newTable(owner); let order = await account(owner, 1, table.id)
    let linked = await execute<ServiceResponses['associate_service_tables']>(owner, { command: 'associate_service_tables', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, expectedVisitRevision: null, tableIds: [table.id, table2.id] }); order = linked.order
    order = await pay(owner, order)
    const source = order
    const salesBefore = (await db.query('select * from app_private.sales where business_id=$1', [owner.businessId])).rows
    const command = { command: 'continue_service_order' as const, operationId: randomUUID(), sourceOrderId: order.id, expectedRevision: order.revision, orderId: randomUUID(), name: 'Sobremesa' }
    const continued = await execute<ServiceResponses['continue_service_order']>(owner, command)
    expect(continued.order).toMatchObject({ tableId: null, orderKind: 'service', items: [], frozen: false, balanceCents: 0 })
    expect(continued.visit.orders).toHaveLength(2); expect(continued.visit.orders[0]).toEqual(source)
    expect(await execute(owner, command)).toEqual(continued)
    await expect(execute(owner, { ...command, operationId: randomUUID(), orderId: randomUUID() })).rejects.toThrow('ORDER_CHANGED')
    expect(await execute(owner, { command: 'order', orderId: source.id })).toEqual(source)
    expect((await db.query('select * from app_private.sales where business_id=$1', [owner.businessId])).rows).toEqual(salesBefore)
    expect((await execute<{ tables: DiningTable[] }>(owner, { command: 'tables' })).tables.find(t => t.id === table.id)).toMatchObject({ orderId: continued.order.id, visitId: continued.visit.id })
    await expect(account(owner, 1, table2.id)).rejects.toThrow('TABLE_OCCUPIED')
    const other = await account(owner)
    await expect(execute(owner, { command: 'move_order', operationId: randomUUID(), orderId: other.id, expectedRevision: other.revision, tableId: table2.id })).rejects.toThrow('TABLE_OCCUPIED')
    const released = await execute<ServiceResponses['release_service_visit']>(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: continued.visit.id, expectedRevision: continued.visit.revision })
    expect(released).toMatchObject({ status: 'closed', tableIds: [], balanceCents: 0, orders: [expect.anything(), expect.objectContaining({ status: 'closed' })] })
    expect(await account(owner, 1, table2.id)).toMatchObject({ tableId: table2.id })
    expect((await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: source.id })).visit?.orders).toHaveLength(2)
  })

  test('release checks all balances and seating links reservations without exposing contacts to kitchen', async () => {
    const owner = await actor(), table = await newTable(owner), reservation = await execute<ServiceReservation>(owner, reservationCommand(table.id)), order = await account(owner)
    const seated = await execute<ServiceResponses['set_service_reservation_status']>(owner, { command: 'set_service_reservation_status', operationId: randomUUID(), reservationId: reservation.id, expectedRevision: reservation.revision, status: 'seated', orderId: order.id })
    expect(seated.visit?.tableIds).toEqual([table.id])
    await expect(execute(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: seated.visit!.id, expectedRevision: seated.visit!.revision })).rejects.toThrow('VISIT_BALANCE_PENDING')
    const sent = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
    const kitchen = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches[0]
    expect(kitchen.tableName).toBe(table.name); expect(JSON.stringify(kitchen)).not.toContain('Contacto sintético')
    await pay(owner, sent)
    await execute(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: seated.visit!.id, expectedRevision: seated.visit!.revision })
    expect((await execute<ServiceDay>(owner, { command: 'service_day', date: '2026-10-09' })).reservations[0].status).toBe('completed')
    const counter = await account(owner, 1, null, 'counter')
    await expect(execute(owner, { command: 'save_service_course', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision, courseId: randomUUID(), name: 'No válido', items: [{ lineId: counter.items[0].lineId, quantity: 1 }] })).rejects.toThrow('PERMISSION_DENIED')
  })

  test('held quantities cannot be removed; releasing preserves its audit while unsent consumption can be reduced', async () => {
    const owner = await actor(); let order = await account(owner, 3)
    const source = order.items[0], courseId = randomUUID()
    const saved = await execute<ServiceResponses['save_service_course']>(owner, { command: 'save_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId, name: 'Esperar', items: [{ lineId: source.lineId, quantity: 2 }] }); order = saved.order
    const edit = { command: 'save_order' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, orderKind: 'service' as const, name: order.name, tableId: order.tableId, items: [{ lineId: source.lineId, productId: source.productId!, version: source.version, unitPriceCents: source.unitPriceCents, quantity: 1, note: source.note }] }
    await expect(execute(owner, edit)).rejects.toThrow('COURSE_HELD')
    const released = await execute<ServiceResponses['cancel_service_course']>(owner, { command: 'cancel_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId })
    order = await execute(owner, { ...edit, operationId: randomUUID(), expectedRevision: released.order.revision })
    expect(order).toMatchObject({ balanceCents: 1001, items: [expect.objectContaining({ quantity: 1, sentQuantity: 0 })] })
    expect((await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id })).courses[0]).toMatchObject({ status: 'released', items: [{ quantity: 2 }] })
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.order_events where business_id=$1 and order_id=$2 and kind=$3', [owner.businessId, order.id, 'cancel_service_course'])).rows[0].count).toBe(1)
  })

  test('partial payment continuation keeps the earlier balance and refuses to release tables when only the new account is paid', async () => {
    const owner = await actor(), table = await newTable(owner); let original = await account(owner, 3, table.id)
    original = await pay(owner, original, 1)
    const continued = await execute<ServiceResponses['continue_service_order']>(owner, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: original.id, expectedRevision: original.revision, orderId: randomUUID(), name: 'Consumo siguiente' })
    const source = original.items[0]
    let newer = await execute<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: continued.order.id, expectedRevision: continued.order.revision, orderKind: 'service', tableId: null, name: continued.order.name, items: [{ lineId: randomUUID(), productId: source.productId!, version: source.version, unitPriceCents: source.unitPriceCents, quantity: 1, note: '' }] })
    newer = await pay(owner, newer)
    const state = await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: newer.id })
    expect(state.visit).toMatchObject({ balanceCents: 2002, orders: [expect.objectContaining({ id: original.id, frozen: true, balanceCents: 2002 }), expect.objectContaining({ id: newer.id, balanceCents: 0 })] })
    await expect(execute(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: state.visit!.id, expectedRevision: state.visit!.revision })).rejects.toThrow('VISIT_BALANCE_PENDING')
    await pay(owner, original)
    const released = await execute<ServiceResponses['release_service_visit']>(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: state.visit!.id, expectedRevision: state.visit!.revision })
    expect(released.balanceCents).toBe(0); expect(released.orders).toHaveLength(2)
    expect((await db.query<{ count: number; total: number }>('select count(*)::integer count,sum(total_cents)::integer total from app_private.sales where business_id=$1', [owner.businessId])).rows[0]).toEqual({ count: 3, total: 4004 })
  })

  test('service reads are tenant scoped and private storage has no browser access', async () => {
    const owner = await actor(), other = await actor(), reader = await actor(owner.businessId, ['orders.read']), kitchen = await actor(owner.businessId, ['kitchen.read']), order = await account(owner)
    await execute(owner, { command: 'save_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: randomUUID(), name: 'Tiempo', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })
    expect((await execute<ServiceOrderState>(reader, { command: 'service_order', orderId: order.id })).courses).toHaveLength(1)
    await expect(execute(other, { command: 'service_order', orderId: order.id })).rejects.toThrow('ORDER_CHANGED')
    await expect(execute(kitchen, { command: 'service_order', orderId: order.id })).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(kitchen, { command: 'service_day', date: '2026-10-09' })).rejects.toThrow('PERMISSION_DENIED')
    const tables = (await db.query<{ name: string; rls: boolean; readable: boolean }>(`select c.relname name,c.relrowsecurity rls,has_table_privilege('authenticated',c.oid,'SELECT') readable from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname in ('service_visits','service_visit_orders','service_visit_tables','service_courses','service_course_lines','service_reservations','service_reservation_tables')`)).rows
    expect(tables).toHaveLength(7); expect(tables.every(table => table.rls && !table.readable)).toBe(true)
    expect((await db.query<{ granted: boolean }>("select has_function_privilege('authenticated','app_private.pos_command(uuid,uuid,jsonb)','EXECUTE') granted")).rows[0].granted).toBe(false)
  })

  test('returns all accounts at the explicit visit limit and rejects an additional account without truncating balances', async () => {
    const owner = await actor(); let source = await account(owner)
    source = (await execute<ServiceResponses['associate_service_tables']>(owner, { command: 'associate_service_tables', operationId: randomUUID(), orderId: source.id, expectedRevision: source.revision, expectedVisitRevision: null, tableIds: [] })).order
    source = await pay(owner, source)
    await db.query(`with inserted as (insert into app_private.operational_orders(business_id,id,name,order_kind,actor_id,operator_name) select $1,extensions.gen_random_uuid(),'Cuenta sintética límite','service',$2,'Persona sintética' from generate_series(1,99) returning business_id,id) insert into app_private.service_visit_orders(business_id,order_id,visit_id) select business_id,id,$3 from inserted`, [owner.businessId, owner.employeeId, source.id])
    const result = await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: source.id })
    expect(result.visit?.orders).toHaveLength(100); expect(result.visit?.balanceCents).toBe(0)
    await expect(execute(owner, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: source.id, expectedRevision: source.revision, orderId: randomUUID(), name: 'Cuenta 101' })).rejects.toThrow('VISIT_LIMIT_REACHED')
    expect((await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: source.id })).visit?.orders).toHaveLength(100)
  })

  test('association uses the visit revision across accounts and leaves a paid source unchanged', async () => {
    const owner = await actor(), first = await newTable(owner), second = await newTable(owner)
    const paid = await pay(owner, await account(owner, 1, first.id))
    const continued = await execute<ServiceResponses['continue_service_order']>(owner, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: paid.id, expectedRevision: paid.revision, orderId: randomUUID(), name: 'Sobremesa' })
    const fromChild = { command: 'associate_service_tables' as const, operationId: randomUUID(), orderId: continued.order.id, expectedRevision: continued.order.revision, expectedVisitRevision: continued.visit.revision, tableIds: [first.id] }
    const updated = await execute<ServiceResponses['associate_service_tables']>(owner, { ...fromChild, operationId: randomUUID(), orderId: paid.id, expectedRevision: paid.revision, tableIds: [first.id, second.id] })
    expect(updated.order).toEqual(paid)
    await expect(execute(owner, fromChild)).rejects.toThrow('VISIT_CHANGED')
    const command = { ...fromChild, expectedVisitRevision: updated.visit.revision, tableIds: [first.id, second.id] }
    const accepted = await execute<ServiceResponses['associate_service_tables']>(owner, command)
    expect(accepted.visit.tableIds).toEqual([first.id, second.id].sort())
    expect(await execute(owner, command)).toEqual(accepted)
    expect(await execute(owner, { command: 'order', orderId: paid.id })).toEqual(paid)
  })

  test('complete tenant erasure cleans service links without blocking historical financial cleanup', async () => {
    const owner = await actor(), table = await newTable(owner); let order = await account(owner, 2, table.id)
    const saved = await execute<ServiceResponses['save_service_course']>(owner, { command: 'save_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: randomUUID(), name: 'En espera', items: [{ lineId: order.items[0].lineId, quantity: 1 }] }); order = saved.order
    await execute(owner, reservationCommand(table.id))
    await db.query('delete from app_private.businesses where id=$1', [owner.businessId])
    for (const name of ['service_visits', 'service_visit_orders', 'service_visit_tables', 'service_courses', 'service_course_lines', 'service_reservations', 'service_reservation_tables']) expect((await db.query<{ count: number }>(`select count(*)::integer count from app_private.${name} where business_id=$1`, [owner.businessId])).rows[0].count).toBe(0)
  })

  test('ordinary table checkout by a sales-only cashier creates a visit and retains the table after payment', async () => {
    const owner = await actor(), cashier = await actor(owner.businessId, ['catalog.read', 'sales.create', 'orders.read']), table = await newTable(owner), order = await account(owner, 1, table.id)
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
    const paid = await pay(cashier, order)
    const visit = (await execute<ServiceOrderState>(cashier, { command: 'service_order', orderId: paid.id })).visit!
    expect(visit).toMatchObject({ status: 'active', tableIds: [table.id], balanceCents: 0, orders: [expect.objectContaining({ id: paid.id, status: 'closed' })] })
    expect((await execute<{ tables: DiningTable[] }>(cashier, { command: 'tables' })).tables.find(t => t.id === table.id)).toMatchObject({ orderId: paid.id, visitId: visit.id })
    await expect(account(owner, 1, table.id)).rejects.toThrow('TABLE_OCCUPIED')
    await execute(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: visit.id, expectedRevision: visit.revision })
    expect(await account(owner, 1, table.id)).toMatchObject({ tableId: table.id })
    const counter = await account(owner, 1, null, 'counter')
    await pay(owner, counter)
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.service_visit_orders where business_id=$1 and order_id=$2', [owner.businessId, counter.id])).rows[0].count).toBe(0)
  })

  test('direct checkout preparation/completion also creates the visit and failed core checkout rolls it back', async () => {
    const owner = await actor(), table = await newTable(owner), order = await account(owner, 1, table.id)
    await expect(execute(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision + 1 })).rejects.toThrow('ORDER_CHANGED')
    expect((await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id })).visit).toBeNull()
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
    await db.query("update app_private.operational_orders set phase='checkout' where business_id=$1 and id=$2", [owner.businessId, order.id])
    const attempt = await execute<{ id: string; revision: number }>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    const visit = (await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id })).visit!
    expect(visit.tableIds).toEqual([table.id])
    const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true as const }
    const paid = await execute<{ order: OperationalOrder }>(owner, command)
    await execute(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: visit.id, expectedRevision: visit.revision })
    expect(await execute(owner, command)).toEqual(paid)
    expect((await execute<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id })).visit?.status).toBe('closed')
  })
})

async function actor(businessId?: string, permissions: string[] = []): Promise<Actor> {
  const value = { businessId: businessId ?? randomUUID(), userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }, role = businessId ? 'cashier' : 'owner'
  await db.query('insert into auth.users(id) values($1)', [value.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId])
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
async function account(owner: Actor, quantity = 1, tableId: string | null = null, orderKind: 'service' | 'counter' = 'service') {
  const product = await execute<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001 })
  return execute<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind, name: 'Cuenta sintética', tableId, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity, note: 'Sin azúcar' }] })
}
async function newTable(owner: Actor) { return execute<DiningTable>(owner, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa ' + randomUUID().slice(0, 4), active: true }) }
function reservationCommand(tableId: string) { return { command: 'save_service_reservation' as const, operationId: randomUUID(), reservationId: randomUUID(), expectedRevision: null, name: 'Reserva sintética', contact: 'Contacto sintético', partySize: 2, startsAt: '2026-10-09T18:00:00Z', endsAt: '2026-10-09T20:00:00Z', tableIds: [tableId], note: '' } }
async function pay(owner: Actor, original: OperationalOrder, quantity?: number) {
  const open = (await db.query<{ count: number }>("select count(*)::integer count from app_private.cash_shifts where business_id=$1 and status='open'", [owner.businessId])).rows[0].count
  if (!open) await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const order = original.phase === 'checkout' ? original : await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: original.id, expectedRevision: original.revision })
  const attempt = await execute<{ id: string; revision: number }>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: order.items.map(item => ({ lineId: item.lineId, quantity: quantity ?? item.quantity - item.paidQuantity })), paymentMethod: 'cash' })
  return (await execute<{ order: OperationalOrder }>(owner, { command: 'record_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true })).order
}
