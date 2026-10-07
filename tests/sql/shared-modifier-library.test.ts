import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { emptyDetails, includedTax, selectedPrice } from '../../src/lib/product-details'
import { copyModifierSets } from '../../src/lib/product-modifier-copy'
import type { PosCommand, Product, ProductDetails, SharedModifierGroup } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
type SaveProduct = Extract<PosCommand, { command: 'save_product' }>
let db: PGlite
let legacy: { owner: Actor; command: SaveProduct; product: Product }

describe('shared modifier library and whole signed selections', () => {
 beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
   create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && file <= '20261007130000_modifier_selection.sql').sort()) {
   if (file === '20261007120000_shared_modifier_library.sql') {
    const owner = await actor(), command = saveProduct(); legacy = { owner, command, product: await executeRaw<Product>(owner, command) }
   }
   await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }
 }, 90_000)
 afterAll(async () => { await db?.close() })

 it('links two products, propagates versioned edits atomically, preserves independent copies and accepted replay', async () => {
  const owner = await actor(), create = groupCommand()
  const first = await execute<{ group: SharedModifierGroup; products: Product[] }>(owner, create)
  expect(first.products).toEqual([])
  const p1 = await linked(owner, first.group), p2 = await linked(owner, first.group)
  const independent = await execute<Product>(owner, saveProduct({ ...emptyDetails(), modifierSets: copyModifierSets([], [first.group]) }))
  const edit = { ...create, operationId: randomUUID(), expectedVersion: first.group.version, name: 'Extras de barra', options: first.group.options.map(option => ({ ...option, priceCents: option.priceCents + 1 })) }
  const result = await execute<{ group: SharedModifierGroup; products: Product[] }>(owner, edit)
  expect(result.group.version).toBe(2)
  expect(result.group.linkedProducts.map(product => product.id).sort()).toEqual([p1.id, p2.id].sort())
  expect(result.products.map(product => product.version)).toEqual([2, 2])
  expect(result.products.every(product => product.details!.modifierSets[0].name === 'Extras de barra')).toBe(true)
  expect(await execute(owner, edit)).toEqual(result)
  expect(await execute(owner, create)).toEqual(first)
  const catalog = (await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products
  expect(catalog.find(product => product.id === independent.id)).toEqual(independent)
  await expect(execute(owner, { ...edit, operationId: randomUUID() })).rejects.toThrow('PRODUCT_CHANGED')
  await expect(execute(owner, { ...edit, name: 'Otro payload' })).rejects.toThrow('OPERATION_CONFLICT')
  expect(await executeRaw(legacy.owner, legacy.command)).toEqual(legacy.product)
 })

 it('checks current permissions before replay, rejects cross-tenant canonical links and browser table/function access', async () => {
  const owner = await actor(), other = await actor(), command = groupCommand()
  const result = await execute<{ group: SharedModifierGroup }>(owner, command)
  await expect(linked(other, result.group)).rejects.toThrow('PRODUCT_CHANGED')
  const cashier = await actor(owner.businessId, ['catalog.read', 'catalog.availability'])
  expect((await execute<{ groups: SharedModifierGroup[] }>(cashier, { command: 'modifier_groups' })).groups).toHaveLength(1)
  await expect(execute(cashier, { ...command, operationId: randomUUID(), groupId: randomUUID() })).rejects.toThrow('PERMISSION_DENIED')
  await db.query("update app_private.employees set active=false where id=$1", [owner.employeeId])
  await expect(execute(owner, command)).rejects.toThrow('BUSINESS_ACCESS_DENIED')
  for (const role of ['anon', 'authenticated']) {
   for (const fn of ['app_private.pos_command(uuid,uuid,jsonb)', 'app_private.validate_modifier_group(jsonb,boolean)', 'app_private.product_selection(app_private.products,jsonb)'])
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, fn])).rows[0].allowed).toBe(false)
   expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'app_private.modifier_groups','SELECT') allowed", [role])).rows[0].allowed).toBe(false)
  }
 })

 it('rejects malformed HTTP and SQL metadata and rolls back propagation that would make combined required selections exceed 24', async () => {
  const owner = await actor(), command = groupCommand()
  for (const patch of [{ options: [{ ...command.options[0], maxQuantity: 0 }] }, { options: [{ ...command.options[0], priceCents: -100000000 }] }, { options: [{ ...command.options[0], soldOut: 'yes' }] }, { extra: true }, { min: 25 }]) {
   const invalid = { ...command, ...patch } as typeof command
   expect(() => parse(owner, invalid)).toThrow()
   await expect(executeRaw(owner, invalid)).rejects.toThrow('VALIDATION_ERROR')
  }
  const created = await execute<{ group: SharedModifierGroup }>(owner, command)
  const p1 = await linked(owner, created.group), p2 = await linked(owner, created.group)
  const huge = { ...command, operationId: randomUUID(), expectedVersion: 1, min: 24, max: 24, options: [{ ...command.options[0], maxQuantity: 24 }] }
  // Second product's independent mandatory group makes this shared edit invalid.
  await execute(owner, { ...saveProduct(), productId: p2.id, expectedVersion: p2.version, details: { ...p2.details!, modifierSets: [...p2.details!.modifierSets, ...modifierDetails([1]).modifierSets] } })
  await expect(execute(owner, huge)).rejects.toThrow('VALIDATION_ERROR')
  const groups = (await execute<{ groups: SharedModifierGroup[] }>(owner, { command: 'modifier_groups' })).groups
  expect(groups[0].version).toBe(1)
  const catalog = (await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products
  expect(catalog.find(product => product.id === p1.id)).toEqual(p1)
  expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.pos_operations where business_id=$1 and operation_id=$2', [owner.businessId, huge.operationId])).rows[0].count).toBe(0)
 })

 it('prices two shots plus a negative adjustment exactly, snapshots them and splits discounted VAT without repeating effects', async () => {
  const owner = await actor(), created = await execute<{ group: SharedModifierGroup }>(owner, groupCommand()), product = await linked(owner, created.group)
  const selection = { variationId: null, modifierIds: [created.group.options[0].id, created.group.options[0].id, created.group.options[1].id], variablePriceCents: null }
  const unitPriceCents = selectedPrice(product, selection)
  expect(unitPriceCents).toBe(11502)
  await execute(owner, { command: 'activate_operations', operationId: randomUUID() })
  await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  const orderCommand = { ...newOrder(product), items: [{ ...newOrder(product).items[0], unitPriceCents, quantity: 3, selection }] }
  let order = await execute<OperationalOrder>(owner, orderCommand)
  expect(order.items[0]).toMatchObject({ unitPriceCents, selectionLabel: '2 × Shot, Sin leche', kitchenName: 'BARRA' })
  const availability = { command: 'set_modifier_option_sold_out' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version, modifierId: created.group.options[0].id, soldOut: true }
  const unavailable = await execute<{ products: Product[] }>(owner, availability)
  expect(unavailable.products[0].details!.modifierSets[0].options[0].soldOut).toBe(true)
  expect(await execute(owner, orderCommand)).toEqual(order)
  const fresh = unavailable.products[0]
  await expect(execute(owner, { ...newOrder(fresh), items: [{ ...newOrder(fresh).items[0], unitPriceCents, selection }] })).rejects.toThrow('PRODUCT_UNAVAILABLE')
  expect(await execute(owner, availability)).toEqual(unavailable)
  order = await execute<OperationalOrder>(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'percent', value: 1000, reason: 'Promoción sintética' } })
  const expectedTotal = order.totalCents, expectedTax = order.taxCents
  expect(expectedTotal).toBe(31055)
  expect(expectedTax).toBe(includedTax(expectedTotal, 1600))
  order = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  order = await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  const first = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 2 }], paymentMethod: 'cash' })
  const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: first.id, expectedRevision: first.revision, confirmed: true }
  const paid = await execute<{ order: OperationalOrder; attempt: CheckoutAttempt }>(owner, payment)
  expect(await execute(owner, payment)).toEqual(paid)
  const second = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: paid.order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'transfer' })
  expect(first.totalCents + second.totalCents).toBe(expectedTotal)
  expect(first.taxCents + second.taxCents).toBe(expectedTax)
 })
})

function groupCommand(): Extract<PosCommand, { command: 'save_modifier_group' }> {
 return { command: 'save_modifier_group', operationId: randomUUID(), groupId: randomUUID(), expectedVersion: null, name: 'Extras', min: 1, max: 3, options: [{ id: randomUUID(), name: 'Shot', priceCents: 101, maxQuantity: 2 }, { id: randomUUID(), name: 'Sin leche', priceCents: -300 }] }
}
async function linked(owner: Actor, group: SharedModifierGroup): Promise<Product> {
 return execute<Product>(owner, saveProduct({ ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, kitchenName: 'BARRA', modifierSets: [{ id: group.id, libraryId: group.id, name: group.name, min: group.min, max: group.max, options: group.options }] }))
}

function saveProduct(details: ProductDetails = emptyDetails(), priceCents = 11600): SaveProduct {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Latte sintético', category: 'Café', priceCents, details }
}

function modifierDetails(minima: number[]): ProductDetails {
  return {
    ...emptyDetails(), modifierSets: minima.map((min, index) => ({
      id: randomUUID(), name: `Grupo ${index + 1}`, min, max: min,
      options: Array.from({ length: min }, (_, option) => ({ id: randomUUID(), name: `Extra ${option + 1}`, priceCents: 0 })),
    })),
  }
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
