import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyDetails, includedTax, selectedPrice } from '../../src/lib/product-details'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import type { PosCommand, Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
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

describe.skipIf(!config)('Square catalog through real loopback Auth, signed Edge and PostgreSQL', () => {
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

  it('persists optional catalog fields and literal text with concurrent replay and later catalog edits', async () => {
    const operator = await business()
    const details: ProductDetails = {
      ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600,
      kitchenName: 'LATTE BARRA', customerName: 'Latte del cliente',
      tileColor: '#F3D6B8', tileLabel: 'LATTE', sku: 'CAFE-01', barcode: '7501234567890',
      calories: 142, dietary: 'Vegetariano', allergens: 'Avena', favorite: true,
      skipCustomization: true,
      customAttributes: [{ name: 'Origen', value: 'Chiapas' }, { name: 'Ingredientes', value: '<img src=x onerror=alert(1)>' }],
    }
    const command = saveProduct(details)
    const replies = await Promise.all([pos<Product>(operator, command), pos<Product>(operator, command)])
    const saved = data(replies[0])
    expect(data(replies[1])).toEqual(saved)
    expect(saved.details).toEqual(details)
    expect(data(await pos<{ products: Product[] }>(operator, { command: 'catalog' })).products).toEqual([saved])
    const edited = data(await pos<Product>(operator, {
      ...command, operationId: randomUUID(), expectedVersion: saved.version,
      details: { ...details, tileLabel: 'CAFÉ', calories: null, customAttributes: [{ name: 'Origen', value: 'Oaxaca' }] },
    }))
    expect(edited.details).toMatchObject({ skipCustomization: true, tileLabel: 'CAFÉ', calories: null, customAttributes: [{ name: 'Origen', value: 'Oaxaca' }] })
    expect(data(await pos<Product>(operator, command))).toEqual(saved)
    expect(count('products', operator)).toBe(1)
    expect((await pos(operator, { ...command, name: 'Payload distinto' })).body.error?.code).toBe('OPERATION_CONFLICT')
  }, 30_000)

  it('rejects ungranted actors, foreign tenants and malformed optional metadata at the real Edge boundary', async () => {
    const operator = await business(), foreign = await business(outsider)
    const cashier = await cashierFor(operator)
    const command = saveProduct({ ...emptyDetails(), skipCustomization: true, customAttributes: [{ name: 'Origen', value: 'Chiapas' }] })
    const product = data(await pos<Product>(operator, command))
    expect(data(await pos<{ products: Product[] }>(cashier, { command: 'catalog' }, employee)).products).toEqual([product])
    expect((await pos(cashier, { ...command, operationId: randomUUID(), productId: randomUUID() }, employee)).body.error?.code).toBe('PERMISSION_DENIED')
    expect((await pos(foreign, { ...command, operationId: randomUUID(), expectedVersion: product.version }, outsider)).body.error?.code).toBe('PRODUCT_CHANGED')
    expect((await pos(operator, { command: 'catalog' }, outsider)).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect(data(await pos<{ products: Product[] }>(foreign, { command: 'catalog' }, outsider)).products).toEqual([])
    for (const patch of [
      { unsupportedField: true }, { skipCustomization: 'true' },
      { customAttributes: [{ name: 'Origen', value: '' }] },
      { customAttributes: [{ name: 'Origen', value: 'Chiapas', unknown: true }] },
      { customAttributes: [{ name: 'Origen', value: 'Chiapas' }, { name: ' origen ', value: 'Oaxaca' }] },
      { customAttributes: [{ name: 'Ingredientes', value: 'Café\u0001' }] },
      { customAttributes: Array.from({ length: 9 }, (_, index) => ({ name: `Dato ${index}`, value: 'Sintético' })) },
      { modifierSets: [9, 8, 8].map((min, index) => ({ id: randomUUID(), name: `Grupo ${index}`, min, max: min, options: Array.from({ length: min }, (_, option) => ({ id: randomUUID(), name: `Extra ${option}`, priceCents: 0 })) })) },
    ]) {
      const rejected = await call(owner, { action: 'pos', ...args(operator), ...saveProduct(), details: { ...emptyDetails(), ...patch } })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error?.code).toBe('VALIDATION_ERROR')
    }
    expect(count('products', operator)).toBe(1)
    data(await call(owner, { action: 'lock', ...args(operator) }))
    expect((await pos(operator, command)).body.error?.code).toBe('SESSION_INVALID')
  }, 30_000)

  it('keeps required choices authoritative and retains public/kitchen labels, open price and IVA through payment replay', async () => {
    const operator = await business()
    data(await pos(operator, { command: 'activate_operations', operationId: randomUUID() }))
    data(await pos(operator, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }))
    const modifierId = randomUUID()
    const product = data(await pos<Product>(operator, saveProduct({
      ...emptyDetails(), variablePrice: true, skipCustomization: true,
      customerName: '<Latte del cliente>', kitchenName: 'LATTE BARRA', taxTreatment: 'vat_16', taxBps: 1600,
      modifierSets: [{ id: randomUUID(), name: 'Leche', min: 1, max: 1, options: [{ id: modifierId, name: 'Avena', priceCents: 101 }] }],
    }, 0)))
    const selection = { variationId: null, modifierIds: [modifierId], variablePriceCents: 11601 }
    const unitPriceCents = selectedPrice(product, selection)
    const command: Extract<PosCommand, { command: 'save_order' }> = {
      command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null,
      name: 'Cuenta sintética', tableId: null, orderKind: 'service',
      items: [{ lineId: randomUUID(), productId: product.id, quantity: 3, unitPriceCents, version: product.version, note: 'Sin espuma', selection }],
    }
    for (const invalidSelection of [{ ...selection, modifierIds: [] }, { ...selection, variablePriceCents: null }]) {
      const rejected = await pos(operator, { ...command, operationId: randomUUID(), items: [{ ...command.items[0], selection: invalidSelection }] })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error?.code).toBe('VALIDATION_ERROR')
    }
    let order = data(await pos<OperationalOrder>(operator, command))
    const totalCents = unitPriceCents * 3, taxCents = includedTax(totalCents, 1600)
    expect(order).toMatchObject({ totalCents, taxCents, items: [{ name: '<Latte del cliente>', kitchenName: 'LATTE BARRA', selectionLabel: 'Avena', unitPriceCents, taxTreatment: 'vat_16' }] })
    data(await pos<Product>(operator, {
      ...saveProduct({ ...product.details!, variablePrice: false, modifierSets: [], customerName: 'Alias posterior', kitchenName: 'Cocina posterior', taxTreatment: 'exempt', taxBps: 0 }, 99999),
      productId: product.id, expectedVersion: product.version,
    }))
    expect(data(await pos<OperationalOrder>(operator, command))).toEqual(order)
    order = data(await pos<OperationalOrder>(operator, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    const batch = data(await pos<{ batches: KitchenBatch[] }>(operator, { command: 'kitchen' })).batches.find(entry => entry.orderId === order.id)
    expect(batch?.items[0]).toMatchObject({ name: 'LATTE BARRA', selectionLabel: 'Avena', note: 'Sin espuma', quantity: 3 })
    order = data(await pos<OperationalOrder>(operator, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }))
    const quote = data(await pos<CheckoutAttempt>(operator, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 3 }], paymentMethod: 'cash' }))
    expect(quote).toMatchObject({ totalCents, taxCents, items: [{ name: '<Latte del cliente>', unitPriceCents }] })
    const payment: PosCommand = { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
    const replies = await Promise.all([pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(operator, payment), pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(operator, payment)])
    const paid = data(replies[0])
    expect(data(replies[1])).toEqual(paid)
    expect(count('sales', operator)).toBe(1)
    const receipt = data(await pos<Sale>(operator, { command: 'sale', saleId: paid.attempt.saleId! }))
    expect(receipt).toMatchObject({ totalCents, items: [{ name: '<Latte del cliente>', unitPriceCents, totalCents, taxCents, taxBps: 1600, taxTreatment: 'vat_16', selectionLabel: 'Avena' }] })
  }, 30_000)
})

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
  const email = `square-catalog-${randomUUID()}@example.test`, password = `local-only-${randomUUID()}-Aa9!`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  users.push(created.data.user.id)
  const login = await client(config!.anonKey).auth.signInWithPassword({ email, password })
  if (login.error) throw login.error
  return { userId: created.data.user.id, token: login.data.session!.access_token }
}
async function business(identity = owner): Promise<Operator> {
  const operator = data(await call<Operator>(identity, {
    action: 'create_business', name: 'Catálogo Square sintético', businessType: 'cafe', timezone: 'America/Mexico_City', pin, operationId: randomUUID(),
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
