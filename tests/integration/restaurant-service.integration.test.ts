import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OperatorSession } from '../../src/lib/contracts'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, DiningTable, KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { ServiceOrderState, ServiceReservation, ServiceResponses } from '../../src/lib/service-contracts'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import { emptyDetails } from '../../src/lib/product-details'
import { signedRequest } from './device-proof-fixture'

type Identity = { userId: string; token: string }
type Actor = { identity: Identity; operator: OperatorSession }
type Reply<T> = { status: number; body: { data?: T; error?: { code: string } } }
const config = localConfig(), users: string[] = [], businesses: string[] = []
let admin: SupabaseClient

describe.skipIf(!config)('restaurant service through real loopback Auth, signed Edge and PostgreSQL', () => {
  beforeAll(() => {
    admin = createClient(config!.url, config!.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    expect(sql("select to_regclass('app_private.service_courses') is not null;").trim()).toBe('t')
  })
  afterAll(async () => {
    if (businesses.length) {
      sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
      expect(sql(`select count(*) from app_private.businesses where id in (${businesses.map(uuid).join(',')});`).trim()).toBe('0')
    }
    const errors: Error[] = []
    for (const id of users) { const deleted = await admin.auth.admin.deleteUser(id); if (deleted.error) errors.push(deleted.error) }
    if (errors.length) throw new Error(`Cleanup failed for ${errors.length} synthetic Auth users`)
  }, 60_000)

  it('retains selected consumption, sends kitchen snapshots once, pays and continues in a linked account preserving receipts', async () => {
    const owner = await actor(), first = await table(owner), second = await table(owner), product = await item(owner)
    let order = await account(owner, product, 3, first.id)
    const course = { command: 'save_service_course' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: randomUUID(), name: 'Entradas', items: [{ lineId: order.items[0].lineId, quantity: 2 }] }
    const held = data(await pos<ServiceResponses['save_service_course']>(owner, course)); order = held.order
    expect(held.courses[0]).toMatchObject({ status: 'held', items: [{ quantity: 2 }] })
    expect((await pos(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })).body.error?.code).toBe('COURSE_HELD')
    expect((await pos(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })).body.error?.code).toBe('COURSE_HELD')
    const send = { command: 'send_service_course' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: course.courseId }
    const sends = await Promise.all([pos<ServiceResponses['send_service_course']>(owner, send), pos<ServiceResponses['send_service_course']>(owner, send)])
    const sent = data(sends[0]); expect(data(sends[1])).toEqual(sent); order = sent.order
    const batch = data(await pos<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches.find(batch => batch.id === sent.courses[0].batchId)!
    expect(batch).toMatchObject({ tableName: first.name, orderName: `${order.name} · Entradas`, items: [{ lineId: order.items[0].lineId, quantity: 2, note: 'Sin azúcar', name: 'CAFÉ BARRA' }] })
    const state = data(await pos<ServiceOrderState>(owner, { command: 'service_order', orderId: order.id }))
    const associated = data(await pos<ServiceResponses['associate_service_tables']>(owner, { command: 'associate_service_tables', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, expectedVisitRevision: state.visit!.revision, tableIds: [first.id, second.id] })); order = associated.order
    order = data(await pos<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    const paid = await pay(owner, order), source = paid.order
    const receipt = data(await pos<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! }))
    expect(source).toMatchObject({ status: 'closed', paidCents: 3003, balanceCents: 0 })
    const command = { command: 'continue_service_order' as const, operationId: randomUUID(), sourceOrderId: source.id, expectedRevision: source.revision, orderId: randomUUID(), name: 'Sobremesa' }
    const continuations = await Promise.all([pos<ServiceResponses['continue_service_order']>(owner, command), pos<ServiceResponses['continue_service_order']>(owner, command)])
    const continued = data(continuations[0]); expect(data(continuations[1])).toEqual(continued)
    expect(continued.order).toMatchObject({ tableId: null, orderKind: 'service', balanceCents: 0, frozen: false, items: [] })
    expect(continued.visit.orders).toHaveLength(2); expect(continued.visit.orders.find(order => order.id === source.id)).toEqual(source)
    expect(data(await pos<Sale>(owner, { command: 'sale', saleId: receipt.id }))).toEqual(receipt)
    expect((await accountReply(owner, product, 1, second.id)).body.error?.code).toBe('TABLE_OCCUPIED')
    let newer = data(await pos<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: continued.order.id, expectedRevision: continued.order.revision, orderKind: 'service', name: continued.order.name, tableId: null, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity: 1, note: '' }] }))
    newer = (await pay(owner, newer)).order
    const visit = data(await pos<ServiceOrderState>(owner, { command: 'service_order', orderId: newer.id })).visit!
    expect(visit).toMatchObject({ balanceCents: 0, tableIds: [first.id, second.id].sort() })
    const release = { command: 'release_service_visit' as const, operationId: randomUUID(), visitId: visit.id, expectedRevision: visit.revision }
    const released = data(await pos<ServiceResponses['release_service_visit']>(owner, release))
    expect(released.status).toBe('closed'); expect(data(await pos(owner, release))).toEqual(released)
    expect(await account(owner, product, 1, second.id)).toMatchObject({ tableId: second.id })
    expect(count('sales', owner)).toBe(2)
  }, 30_000)

  it('serializes conflicting reservations, preserves replay and rejects cross-tenant references without leaking contact', async () => {
    const owner = await actor(), outsider = await actor(), place = await table(owner), product = await item(owner), order = await account(owner, product)
    const draft = { command: 'save_service_reservation' as const, operationId: randomUUID(), reservationId: randomUUID(), expectedRevision: null, name: 'Reserva sintética', contact: 'Contacto reservado sintético', partySize: 2, startsAt: '2026-10-09T12:00:00-06:00', endsAt: '2026-10-09T20:00:00Z', tableIds: [place.id], note: 'Prueba sin datos humanos' }
    const collision = { ...draft, operationId: randomUUID(), reservationId: randomUUID() }
    const replies = await Promise.all([pos<ServiceReservation>(owner, draft), pos<ServiceReservation>(owner, collision)])
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1)
    expect(replies.find(reply => reply.status !== 200)?.body.error?.code).toBe('RESERVATION_CONFLICT')
    const winner = replies[0].status === 200 ? draft : collision, reservation = data(replies.find(reply => reply.status === 200)!)
    expect(reservation.startsAt).toBe('2026-10-09T18:00:00+00:00')
    expect(data(await pos(owner, winner))).toEqual(reservation)
    expect((await pos(owner, { ...winner, contact: 'Cambio de payload' })).body.error?.code).toBe('OPERATION_CONFLICT')
    const foreignRead = await pos(outsider, { command: 'service_order', orderId: order.id })
    expect(foreignRead.body.error?.code).toBe('ORDER_CHANGED'); expect(JSON.stringify(foreignRead)).not.toContain(draft.contact)
    expect((await pos(outsider, { command: 'set_service_reservation_status', operationId: randomUUID(), reservationId: reservation.id, expectedRevision: reservation.revision, status: 'cancelled', orderId: null })).body.error?.code).toBe('RESERVATION_CHANGED')
    const seated = data(await pos<ServiceResponses['set_service_reservation_status']>(owner, { command: 'set_service_reservation_status', operationId: randomUUID(), reservationId: reservation.id, expectedRevision: reservation.revision, status: 'seated', orderId: order.id }))
    expect(seated.visit?.tableIds).toEqual([place.id])
    expect((await pos(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: seated.visit!.id, expectedRevision: seated.visit!.revision })).body.error?.code).toBe('VISIT_BALANCE_PENDING')
    data(await pos(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    const kitchen = data(await pos<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
    expect(kitchen[0].tableName).toBe(place.name); expect(JSON.stringify(kitchen)).not.toContain(draft.contact)
  }, 30_000)

  it('uses a sales-only employee for partial service checkout, restores response loss and retains every linked balance', async () => {
    const owner = await actor(), cashier = await employee(owner), place = await table(owner), product = await item(owner), original = await account(owner, product, 3, place.id)
    const paid = await pay(cashier, original, 1)
    expect(paid.order).toMatchObject({ frozen: true, status: 'open', paidCents: 1001, balanceCents: 2002 })
    const state = data(await pos<ServiceOrderState>(cashier, { command: 'service_order', orderId: original.id }))
    expect(state.visit?.tableIds).toEqual([place.id])
    expect((await pos(cashier, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: paid.order.id, expectedRevision: paid.order.revision, orderId: randomUUID(), name: 'No permitido' })).body.error?.code).toBe('PERMISSION_DENIED')
    const continued = data(await pos<ServiceResponses['continue_service_order']>(owner, { command: 'continue_service_order', operationId: randomUUID(), sourceOrderId: paid.order.id, expectedRevision: paid.order.revision, orderId: randomUUID(), name: 'Consumo posterior' }))
    expect(continued.visit.balanceCents).toBe(2002); expect(continued.visit.orders).toHaveLength(2)
    expect((await pos(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: continued.visit.id, expectedRevision: continued.visit.revision })).body.error?.code).toBe('VISIT_BALANCE_PENDING')
    const snapshot = data(await pos<OperationsSnapshot>(owner, { command: 'operations' }))
    expect(snapshot.tables.find(table => table.id === place.id)?.orderId).toBe(continued.order.id)
    const remaining = data(await pos<CheckoutAttempt>(cashier, { command: 'prepare_checkout', operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, items: [{ lineId: paid.order.items[0].lineId, quantity: 2 }], paymentMethod: 'cash' }))
    const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: remaining.id, expectedRevision: remaining.revision, confirmed: true }
    const lost = await raw(cashier.identity, { action: 'pos', ...args(cashier), ...command }); expect(lost.status).toBe(200); await lost.body?.cancel()
    const recovered = data(await pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(cashier, command))
    expect(recovered.order).toMatchObject({ status: 'closed', balanceCents: 0, paidCents: 3003 })
    expect(data(await pos(cashier, command))).toEqual(recovered); expect(count('sales', owner)).toBe(2)
    const visit = data(await pos<ServiceOrderState>(owner, { command: 'service_order', orderId: original.id })).visit!
    data(await pos(owner, { command: 'release_service_visit', operationId: randomUUID(), visitId: visit.id, expectedRevision: visit.revision }))
    expect(data(await pos(cashier, command))).toEqual(recovered)
    data(await call(cashier.identity, { action: 'lock', ...args(cashier) }))
    expect((await pos(cashier, command)).body.error?.code).toBe('SESSION_INVALID')
  }, 30_000)

  it('continues a fully paid legacy account whose stored profile lacks the mode flag, preserving receipts and explicit disablement', async () => {
    const owner = await actor(), place = await table(owner), product = await item(owner)
    const businessId = uuid(owner.operator.business.id)
    // Only this synthetic tenant is adjusted to represent a persisted pre-flag profile.
    sql(`update app_private.businesses set profile=profile-'accountsEnabled' where id=${businessId};`)
    expect(sql(`select profile?'accountsEnabled' from app_private.businesses where id=${businessId};`).trim()).toBe('f')
    let order = await account(owner, product, 1, place.id)
    const courseId = randomUUID()
    order = data(await pos<ServiceResponses['save_service_course']>(owner, { command: 'save_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId, name: 'Entradas', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })).order
    order = data(await pos<ServiceResponses['send_service_course']>(owner, { command: 'send_service_course', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId })).order
    const paid = await pay(owner, order)
    expect(paid.order).toMatchObject({ status: 'closed', frozen: true, balanceCents: 0, paidCents: product.priceCents })
    const receipt = data(await pos<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! }))
    const command = { command: 'continue_service_order' as const, operationId: randomUUID(), sourceOrderId: paid.order.id, expectedRevision: paid.order.revision, orderId: randomUUID(), name: 'Sobremesa legacy' }
    const continued = data(await pos<ServiceResponses['continue_service_order']>(owner, command))
    expect(continued.order).toMatchObject({ id: command.orderId, frozen: false, orderKind: 'service', items: [], balanceCents: 0 })
    expect(continued.visit.orders).toEqual([paid.order, continued.order])
    expect(data(await pos<Sale>(owner, { command: 'sale', saleId: receipt.id }))).toEqual(receipt)
    expect(data(await pos<OperationalOrder>(owner, { command: 'order', orderId: paid.order.id }))).toEqual(paid.order)
    sql(`update app_private.businesses set profile=jsonb_set(profile,'{accountsEnabled}','false') where id=${businessId};`)
    expect(data(await pos(owner, command))).toEqual(continued)
    let newer = data(await pos<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: continued.order.id, expectedRevision: continued.order.revision, orderKind: 'service', name: continued.order.name, tableId: null, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity: 1, note: '' }] }))
    newer = (await pay(owner, newer)).order
    expect((await pos(owner, { ...command, operationId: randomUUID(), sourceOrderId: newer.id, expectedRevision: newer.revision, orderId: randomUUID() })).body.error?.code).toBe('PERMISSION_DENIED')
    expect(Number(sql(`select count(*) from app_private.operational_orders where business_id=${businessId};`).trim())).toBe(2)
    data(await call(owner.identity, { action: 'lock', ...args(owner) }))
    expect((await pos(owner, command)).body.error?.code).toBe('SESSION_INVALID')
  }, 30_000)
})

function localConfig() {
  const url = process.env.TEST_SUPABASE_URL
  if (!url) return null
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Service integration refuses non-loopback backends')
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY, serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, dbContainer = process.env.TEST_LOCAL_DB_CONTAINER
  if (!anonKey || !serviceRoleKey || !dbContainer || !/^supabase_db_[a-z0-9_-]+$/.test(dbContainer)) throw new Error('Explicit local service integration credentials and container are required')
  return { url, anonKey, serviceRoleKey, dbContainer }
}
async function identity(): Promise<Identity> {
  const email = `restaurant-service-${randomUUID()}@example.test`, password = `local-only-${randomUUID()}-Aa9!`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error
  users.push(created.data.user.id)
  const login = await createClient(config!.url, config!.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.signInWithPassword({ email, password }); if (login.error) throw login.error
  return { userId: created.data.user.id, token: login.data.session!.access_token }
}
async function actor(): Promise<Actor> {
  const person = await identity()
  const operator = data(await call<OperatorSession>(person, { action: 'create_business', operationId: randomUUID(), name: 'Servicio restaurante sintético', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '583927', profile: { branchName: 'Principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '', accountsEnabled: true, paymentMethods: ['cash', 'transfer'] } }))
  businesses.push(operator.business.id); const value = { identity: person, operator }
  data(await pos(value, { command: 'activate_operations', operationId: randomUUID() })); data(await pos(value, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }))
  return value
}
async function employee(owner: Actor): Promise<Actor> {
  const person = await identity()
  const created = data(await call<{ invitation: { invitationCode: string } }>(owner.identity, { action: 'create_employee', ...args(owner), operationId: randomUUID(), name: 'Caja sintética', role: 'cashier', permissions: ['catalog.read', 'sales.create', 'orders.read'], pin: null, inviteWithGoogle: true }))
  return { identity: person, operator: data(await call<OperatorSession>(person, { action: 'accept_invitation', invitationCode: created.invitation.invitationCode, pin: '024680', operationId: randomUUID() })) }
}
async function item(owner: Actor) { return data(await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: 'Café', priceCents: 1001, details: { ...emptyDetails(), kitchenName: 'CAFÉ BARRA', taxTreatment: 'vat_16', taxBps: 1600 } })) }
async function table(owner: Actor) { return data(await pos<DiningTable>(owner, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: `Mesa sintética ${randomUUID().slice(0, 4)}`, active: true })) }
async function accountReply(owner: Actor, product: Product, quantity = 1, tableId: string | null = null) { return pos<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Visita sintética', orderKind: 'service', tableId, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, quantity, unitPriceCents: product.priceCents, note: 'Sin azúcar' }] }) }
async function account(owner: Actor, product: Product, quantity = 1, tableId: string | null = null) { return data(await accountReply(owner, product, quantity, tableId)) }
async function pay(owner: Actor, original: OperationalOrder, quantity?: number) {
  const order = original.phase === 'checkout' ? original : data(await pos<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: original.id, expectedRevision: original.revision }))
  const attempt = data(await pos<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: order.items.map(line => ({ lineId: line.lineId, quantity: quantity ?? line.quantity - line.paidQuantity })), paymentMethod: 'cash' }))
  return data(await pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(owner, { command: 'record_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true }))
}
function args(actor: Actor) { return { businessId: actor.operator.business.id, operatorToken: actor.operator.operatorToken } }
async function pos<T = unknown>(actor: Actor, command: PosCommand): Promise<Reply<T>> { const result = await call<T>(actor.identity, { action: 'pos', ...args(actor), ...command }); if (result.status === 200) assertFinancialResponse(command, result.body.data); return result }
async function raw(identity: Identity, request: Record<string, unknown>) { return fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, authorization: `Bearer ${identity.token}` }, body: JSON.stringify(await signedRequest(identity.userId, request)) }) }
async function call<T = unknown>(identity: Identity, request: Record<string, unknown>): Promise<Reply<T>> { const response = await raw(identity, request); return { status: response.status, body: await response.json() } }
function data<T>(reply: Reply<T>): T { expect(reply.status, JSON.stringify(reply.body.error)).toBe(200); expect(reply.body.data).toBeDefined(); return reply.body.data! }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID'); return `'${value}'::uuid` }
function sql(query: string) { return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }
function count(table: 'sales', actor: Actor) { return Number(sql(`select count(*) from app_private.${table} where business_id=${uuid(actor.operator.business.id)};`).trim()) }
