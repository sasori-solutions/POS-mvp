import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyDetails, includedTax, selectedPrice } from '../../src/lib/product-details'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import type { PosCommand, Product, ProductDetails, Sale, SharedModifierGroup } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Promotion } from '../../src/lib/promotion-contracts'
import { signedRequest } from './device-proof-fixture'

type Identity = { userId: string; token: string }
type Operator = { business: { id: string; employee: { id: string } }; operatorToken: string }
type Reply<T> = { status: number; body: { data?: T; error?: { code: string } } }
type SaveProduct = Extract<PosCommand, { command: 'save_product' }>
const config = localConfig()
const users: string[] = [], businesses: string[] = []
const pin = '583927'
let admin: SupabaseClient
let owner: Identity, outsider: Identity, employee: Identity

describe.skipIf(!config)('Shared extras through real loopback Auth, signed Edge and PostgreSQL', () => {
  beforeAll(async () => {
    admin = client(config!.serviceRoleKey)
    ;[owner, outsider, employee] = await Promise.all([identity(), identity(), identity()])
    expect((await call(owner, { action: 'status' })).status).toBe(200)
  }, 60_000)
  afterAll(async () => {
    if (!admin) return
    const cleanupErrors: Error[] = []
    for (const id of users) {
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) cleanupErrors.push(error)
    }
    if (businesses.length) {
      sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
      expect(sql(`select count(*) from app_private.businesses where id in (${businesses.map(uuid).join(',')});`).trim()).toBe('0')
    }
    if (cleanupErrors.length) throw new Error(`Synthetic Auth cleanup failed for ${cleanupErrors.length} fixture users`)
  }, 60_000)


  it('propagates linked changes concurrently once, keeps independent copies and checks current authority before replay', async () => {
    const operator = await business(), cashier = await cashierFor(operator), create = groupCommand()
    const created = data(await pos<{ group: SharedModifierGroup; products: Product[] }>(operator, create))
    const p1 = await linked(operator, created.group), p2 = await linked(operator, created.group)
    const copy = data(await pos<Product>(operator, saveProduct({ ...emptyDetails(), modifierSets: [{ ...inline(created.group), id: randomUUID(), options: created.group.options.map(option => ({ ...option, id: randomUUID() })) }] })))
    const edit = { ...create, operationId: randomUUID(), expectedVersion: created.group.version, name: 'Extras compartidos actualizados' }
    const replies = await Promise.all([pos<{ group: SharedModifierGroup; products: Product[] }>(operator, edit), pos<{ group: SharedModifierGroup; products: Product[] }>(operator, edit)])
    const saved = data(replies[0]); expect(data(replies[1])).toEqual(saved)
    expect(saved.products.map(product => product.version)).toEqual([2, 2])
    expect(saved.group.linkedProducts.map(product => product.id).sort()).toEqual([p1.id, p2.id].sort())
    const catalog = data(await pos<{ products: Product[] }>(operator, { command: 'catalog' })).products
    expect(catalog.find(product => product.id === copy.id)).toEqual(copy)
    expect((await pos(cashier, { ...create, operationId: randomUUID(), groupId: randomUUID() }, employee)).body.error?.code).toBe('PERMISSION_DENIED')
    const foreign = await business(outsider)
    expect((await pos(foreign, saveProduct({ ...emptyDetails(), modifierSets: [{ ...inline(saved.group), libraryId: saved.group.id }] }), outsider)).body.error?.code).toBe('PRODUCT_CHANGED')
    expect((await pos(operator, { ...edit, name: 'Payload incompatible' })).body.error?.code).toBe('OPERATION_CONFLICT')
    data(await call(owner, { action: 'lock', ...args(operator) }))
    expect((await pos(operator, edit)).body.error?.code).toBe('SESSION_INVALID')
  }, 30_000)

  it('persists repeated signed extras, rejects new unavailable choices and retains accepted snapshots through exact payment replay', async () => {
    const operator = await business(), created = data(await pos<{ group: SharedModifierGroup }>(operator, groupCommand())), product = await linked(operator, created.group)
    data(await pos(operator, { command: 'activate_operations', operationId: randomUUID() }))
    data(await pos(operator, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }))
    const selection = { variationId: null, modifierIds: [created.group.options[0].id, created.group.options[0].id, created.group.options[1].id], variablePriceCents: null }
    const unitPriceCents = selectedPrice(product, selection)
    const command: Extract<PosCommand, { command: 'save_order' }> = { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, orderKind: 'service', items: [{ lineId: randomUUID(), productId: product.id, quantity: 3, version: product.version, unitPriceCents, selection, note: 'Sin espuma' }] }
    let order = data(await pos<OperationalOrder>(operator, command))
    expect(order).toMatchObject({ totalCents: 34506, taxCents: includedTax(34506, 1600), items: [{ selectionLabel: '2 × Shot, Sin leche', kitchenName: 'BARRA', unitPriceCents: 11502 }] })
    const availability = { command: 'set_modifier_option_sold_out' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version, modifierId: created.group.options[0].id, soldOut: true }
    const updated = data(await pos<{ products: Product[] }>(operator, availability)).products[0]
    expect((await pos(operator, { ...command, operationId: randomUUID(), orderId: randomUUID(), items: [{ ...command.items[0], version: updated.version }] })).body.error?.code).toBe('PRODUCT_UNAVAILABLE')
    expect(data(await pos(operator, command))).toEqual(order)
    order = data(await pos<OperationalOrder>(operator, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    order = data(await pos<OperationalOrder>(operator, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    const attempt = data(await pos<CheckoutAttempt>(operator, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 3 }], paymentMethod: 'cash' }))
    const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true }
    const replies = await Promise.all([pos<{ attempt: CheckoutAttempt }>(operator, payment), pos<{ attempt: CheckoutAttempt }>(operator, payment)])
    const paid = data(replies[0]); expect(data(replies[1])).toEqual(paid)
    expect(count('sales', operator)).toBe(1)
    const receipt = data(await pos<Sale>(operator, { command: 'sale', saleId: paid.attempt.saleId! }))
    expect(receipt.items[0]).toMatchObject({ selectionLabel: '2 × Shot, Sin leche', unitPriceCents: 11502, totalCents: 34506, taxCents: includedTax(34506, 1600) })
  }, 30_000)

  it('preserves a nested component preparation through combo pay-first, changed availability, concurrent recovery and automatic kitchen batch', async () => {
    const operator = await business(), parent = randomUUID(), shot = randomUUID()
    const child = data(await pos<Product>(operator, saveProduct({ ...emptyDetails(), customerName: 'Café público', kitchenName: 'CAFE BARRA', modifierSets: [
      { id: randomUUID(), name: 'Preparación', min: 1, max: 1, options: [{ id: parent, name: 'Doble', priceCents: 0 }] },
      { id: randomUUID(), name: 'Extras', parentOptionId: parent, min: 2, max: 2, options: [{ id: shot, name: 'Shot', priceCents: 101, maxQuantity: 2 }] },
    ] })))
    const selection = { variationId: null, modifierIds: [parent, shot, shot].sort(), variablePriceCents: null }
    const combo = data(await pos<Product>(operator, saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, comboComponents: [{ productId: child.id, version: child.version, quantity: 2, selection }] }, 1001)))
    expect(combo.comboComponents).toEqual([{ productId: child.id, version: child.version, quantity: 2, name: 'Café público', kitchenName: 'CAFE BARRA', selectionLabel: 'Doble, 2 × Shot' }])
    data(await pos(operator, { command: 'activate_operations', operationId: randomUUID() })); data(await pos(operator, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }))
    const command: Extract<PosCommand, { command: 'save_order' }> = { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Combo sintético', tableId: null, orderKind: 'counter', items: [{ lineId: randomUUID(), productId: combo.id, quantity: 2, unitPriceCents: 1001, version: combo.version, note: '' }] }
    const order = data(await pos<OperationalOrder>(operator, command))
    expect(order.items[0].comboComponents).toEqual(combo.comboComponents)
    data(await pos(operator, { command: 'set_modifier_option_sold_out', operationId: randomUUID(), productId: child.id, expectedVersion: child.version, modifierId: shot, soldOut: true }))
    expect((await pos(operator, { ...command, operationId: randomUUID(), orderId: randomUUID() })).body.error?.code).toBe('PRODUCT_UNAVAILABLE')
    expect(data(await pos(operator, command))).toEqual(order)
    const quote = data(await pos<CheckoutAttempt>(operator, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 2 }], paymentMethod: 'cash' }))
    const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
    const replies = await Promise.all([pos<{ attempt: CheckoutAttempt }>(operator, payment), pos<{ attempt: CheckoutAttempt }>(operator, payment)])
    const paid = data(replies[0]); expect(data(replies[1])).toEqual(paid)
    const receipt = data(await pos<Sale>(operator, { command: 'sale', saleId: paid.attempt.saleId! }))
    expect(receipt.items[0]).toMatchObject({ totalCents: 2002, taxCents: includedTax(2002,1600), comboComponents: combo.comboComponents })
    const batches = data(await pos<{ batches: KitchenBatch[] }>(operator, { command: 'kitchen' })).batches.filter(batch => batch.orderId === order.id)
    expect(batches).toEqual([expect.objectContaining({ items: [expect.objectContaining({ quantity: 2, comboComponents: combo.comboComponents })] })])
    expect(count('sales', operator)).toBe(1)
  }, 30_000)

  it('applies a persisted scoped promotion once and keeps accepted category/price/discount snapshots through pause and payment', async () => {
    const operator = await business()
    const eligible = data(await pos<Product>(operator, { ...saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 },1001), category: 'Cafe\u0301' }))
    const other = data(await pos<Product>(operator, { ...saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 },101), category: 'Pan' }))
    data(await pos(operator,{command:'activate_operations',operationId:randomUUID()})); data(await pos(operator,{command:'open_shift',operationId:randomUUID(),openingCents:0}))
    let order = data(await pos<OperationalOrder>(operator,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Oferta sintética',tableId:null,orderKind:'service',items:[eligible,other].map((product,index)=>({lineId:randomUUID(),productId:product.id,quantity:index===0?2:1,unitPriceCents:product.priceCents,version:product.version,note:''}))}))
    const create = {command:'save_promotion' as const,operationId:randomUUID(),promotionId:randomUUID(),expectedRevision:null,name:'Oferta de café',active:true,kind:'fixed' as const,value:1,scope:{productIds:[],categories:['Café']}}
    const saved = data(await pos<Promotion>(operator,create))
    const apply = {command:'apply_order_promotion' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,promotionId:saved.id,promotionRevision:saved.revision}
    const replies = await Promise.all([pos<OperationalOrder>(operator,apply),pos<OperationalOrder>(operator,apply)])
    const accepted = data(replies[0]); expect(data(replies[1])).toEqual(accepted)
    expect(accepted.discount).toMatchObject({scope:saved.scope,promotion:{id:saved.id,revision:1,name:saved.name}})
    expect(accepted.items.find(line=>line.productId===other.id)?.discountCents).toBe(0)
    data(await pos(operator,{...create,operationId:randomUUID(),expectedRevision:1,active:false,name:'Oferta pausada'}))
    data(await pos(operator,{...saveProduct(eligible.details!,99999),productId:eligible.id,expectedVersion:eligible.version,category:'Otro'}))
    expect(data(await pos(operator,apply))).toEqual(accepted)
    order = data(await pos<OperationalOrder>(operator,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:accepted.revision}))
    const quote = data(await pos<CheckoutAttempt>(operator,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,paymentMethod:'cash',items:order.items.map(line=>({lineId:line.lineId,quantity:line.quantity}))}))
    const paid = data(await pos<{attempt:CheckoutAttempt}>(operator,{command:'record_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true}))
    const receipt = data(await pos<Sale>(operator,{command:'sale',saleId:paid.attempt.saleId!}))
    expect(receipt.totalCents).toBe(2102)
    expect(receipt.items.find(line=>line.productId===eligible.id)).toMatchObject({category:'Cafe\u0301',unitPriceCents:1001,discountCents:1,totalCents:2001,taxCents:includedTax(2001,1600)})
    expect(data(await pos(operator,apply))).toEqual(accepted)
    expect(count('sales',operator)).toBe(1)
  },30_000)
})

function groupCommand(): Extract<PosCommand, { command: 'save_modifier_group' }> {
 return { command: 'save_modifier_group', operationId: randomUUID(), groupId: randomUUID(), expectedVersion: null, name: 'Extras', min: 1, max: 3, options: [{ id: randomUUID(), name: 'Shot', priceCents: 101, maxQuantity: 2 }, { id: randomUUID(), name: 'Sin leche', priceCents: -300 }] }
}
function inline(group: SharedModifierGroup) { return { id: group.id, name: group.name, min: group.min, max: group.max, options: group.options } }
async function linked(operator: Operator, group: SharedModifierGroup): Promise<Product> {
 return data(await pos<Product>(operator, saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, kitchenName: 'BARRA', modifierSets: [{ ...inline(group), libraryId: group.id }] })))
}

function localConfig() {
  const url = process.env.TEST_SUPABASE_URL
  if (!url) return null
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Catalog integration refuses non-loopback services')
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY, serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY
  const dbContainer = process.env.TEST_LOCAL_DB_CONTAINER
  if (!anonKey || !serviceRoleKey || !dbContainer || !/^supabase_db_[a-z0-9_-]+$/.test(dbContainer)) throw new Error('Explicit local catalog integration credentials and container are required')
  return { url, anonKey, serviceRoleKey, dbContainer }
}
function client(key: string) {
  return createClient(config!.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}
async function identity(): Promise<Identity> {
  const email = `shared-catalog-${randomUUID()}@example.test`, password = `local-only-${randomUUID()}-Aa9!`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  users.push(created.data.user.id)
  const login = await client(config!.anonKey).auth.signInWithPassword({ email, password })
  if (login.error) throw login.error
  return { userId: created.data.user.id, token: login.data.session!.access_token }
}
async function business(identity = owner): Promise<Operator> {
  const operator = data(await call<Operator>(identity, {
    action: 'create_business', name: 'Biblioteca de extras sintética', businessType: 'cafe', timezone: 'America/Mexico_City', pin, operationId: randomUUID(),
    profile: { branchName: 'Principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '', accountsEnabled: true, paymentMethods: ['cash', 'card_external', 'transfer'] },
  }))
  businesses.push(operator.business.id)
  return operator
}
async function cashierFor(operator: Operator): Promise<Operator> {
  const person = data(await call<{ invitation: { invitationCode: string } }>(owner, {
    action: 'create_employee', ...args(operator), name: 'Caja sintética', role: 'cashier',
    permissions: ['catalog.read', 'catalog.availability', 'sales.create', 'sales.read_own'], pin: null, inviteWithGoogle: true, operationId: randomUUID(),
  }))
  return data(await call<Operator>(employee, { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: '024680', operationId: randomUUID() }))
}
function saveProduct(details: ProductDetails = emptyDetails(), priceCents = 11600): SaveProduct {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Latte sintético', category: 'Café', priceCents, details }
}
function args(operator: Operator) { return { businessId: operator.business.id, operatorToken: operator.operatorToken } }
async function pos<T = unknown>(operator: Operator, command: PosCommand, identity = owner): Promise<Reply<T>> {
  const reply = await call<T>(identity, { action: 'pos', ...args(operator), ...command })
  if (reply.status === 200) assertFinancialResponse(command, reply.body.data)
  return reply
}
async function call<T = unknown>(identity: Identity, request: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, authorization: `Bearer ${identity.token}` },
    body: JSON.stringify(await signedRequest(identity.userId, request)),
  })
  return { status: response.status, body: await response.json() }
}
function data<T>(reply: Reply<T>): T {
  expect(reply.status, JSON.stringify(reply.body.error)).toBe(200)
  expect(reply.body.data).toBeDefined()
  return reply.body.data!
}
function uuid(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID')
  return `'${value}'::uuid`
}
function sql(query: string) {
  return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
function count(table: 'products' | 'sales', operator: Operator) {
  return Number(sql(`select count(*) from app_private.${table} where business_id=${uuid(operator.business.id)};`).trim())
}
