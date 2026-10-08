import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { emptyDetails, selectedPrice } from '../../src/lib/product-details'
import { copyModifierSets } from '../../src/lib/product-modifier-copy'
import type { PosCommand, Product, ProductDetails, SharedModifierGroup } from '../../src/lib/pos-contracts'
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
type SaveProduct = Extract<PosCommand, { command: 'save_product' }>
let db: PGlite
describe('conditional extras in current HTTP and private SQL', () => {
 beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && (file <= '20261007130000_modifier_selection.sql' || file === '20261007170000_nested_modifiers.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
 }, 90_000)
 afterAll(async () => { await db?.close() })

 it('requires children only for selected parent branches and rejects forged hidden selections, cycles, depth and dangling references', async () => {
  const owner = await actor(), parent = randomUUID(), child = randomUUID(), grandchild = randomUUID()
  const groups = [
   { id: randomUUID(), name: 'Preparación', min: 0, max: 1, options: [{ id: parent, name: 'Con leche', priceCents: 100 }] },
   { id: randomUUID(), name: 'Leche', parentOptionId: parent, min: 1, max: 1, options: [{ id: child, name: 'Avena', priceCents: 101 }] },
   { id: randomUUID(), name: 'Temperatura', parentOptionId: child, min: 1, max: 1, options: [{ id: grandchild, name: 'Caliente', priceCents: -50 }] },
  ]
  const details = { ...emptyDetails(), modifierSets: groups }, product = await execute<Product>(owner, saveProduct(details))
  const base = { variationId: null, modifierIds: [], variablePriceCents: null }
  for (const ids of [[parent], [parent, child], [child, grandchild]]) await expect(selection(product, { ...base, modifierIds: ids })).rejects.toThrow('VALIDATION_ERROR')
  expect(await selection(product, base)).toEqual({ price: 11600, label: '' })
  const chosen = { ...base, modifierIds: [parent, child, grandchild] }
  expect(await selection(product, chosen)).toEqual({ price: 11751, label: 'Con leche, Avena, Caliente' })
  expect(selectedPrice(product, chosen)).toBe(11751)
  for (const bad of [
   groups.map((group, index) => index === 0 ? { ...group, parentOptionId: grandchild } : group),
   groups.map((group, index) => index === 1 ? { ...group, parentOptionId: randomUUID() } : group),
   [...groups, { id: randomUUID(), name: 'Cuarto nivel', parentOptionId: grandchild, min: 0, max: 1, options: [{ id: randomUUID(), name: 'Extra', priceCents: 0 }] }],
  ]) {
   const command = saveProduct({ ...details, modifierSets: bad })
   expect(() => parse(owner, command)).toThrow()
   await expect(executeRaw(owner, command)).rejects.toThrow('VALIDATION_ERROR')
  }
 })

 it('disables a parent branch whose required child is unavailable while preserving other available parent choices and copies', async () => {
  const owner = await actor(), parent = randomUUID(), alternate = randomUUID(), child = randomUUID()
  const groups = [{ id: randomUUID(), name: 'Preparación', min: 1, max: 1, options: [{ id: parent, name: 'Con leche', priceCents: 0 }, { id: alternate, name: 'Negro', priceCents: 0 }] }, { id: randomUUID(), name: 'Leche', parentOptionId: parent, min: 1, max: 1, options: [{ id: child, name: 'Avena', priceCents: 0, soldOut: true }] }]
  const product = await execute<Product>(owner, saveProduct({ ...emptyDetails(), modifierSets: groups }))
  await expect(selection(product, { variationId: null, modifierIds: [parent, child], variablePriceCents: null })).rejects.toThrow('PRODUCT_UNAVAILABLE')
  expect(await selection(product, { variationId: null, modifierIds: [alternate], variablePriceCents: null })).toEqual({ price: 11600, label: 'Negro' })
  const copies = copyModifierSets([], groups)
  expect(copies[1].parentOptionId).toBe(copies[0].options[0].id)
  expect(copies[1].parentOptionId).not.toBe(parent)
 })

 it('keeps shared definitions canonical while preserving the product-local parent through propagation and rejects removing a referenced parent', async () => {
  const owner = await actor(), option = randomUUID(), groupId = randomUUID(), create = { command: 'save_modifier_group' as const, operationId: randomUUID(), groupId, expectedVersion: null, name: 'Leche compartida', min: 1, max: 1, options: [{ id: option, name: 'Avena', priceCents: 0 }] }
  const group = (await execute<{ group: SharedModifierGroup }>(owner, create)).group
  const parent = randomUUID()
  const product = await execute<Product>(owner, saveProduct({ ...emptyDetails(), modifierSets: [{ id: randomUUID(), name: 'Preparación', min: 0, max: 1, options: [{ id: parent, name: 'Con leche', priceCents: 0 }] }, { id: group.id, libraryId: group.id, parentOptionId: parent, name: group.name, min: group.min, max: group.max, options: group.options }] }))
  const edit = await execute<{ products: Product[] }>(owner, { ...create, operationId: randomUUID(), expectedVersion: 1, name: 'Leche actualizada' })
  expect(edit.products[0].details!.modifierSets[1]).toMatchObject({ name: 'Leche actualizada', libraryId: group.id, parentOptionId: parent })
  await expect(selection(edit.products[0], { variationId: null, modifierIds: [parent], variablePriceCents: null })).rejects.toThrow('VALIDATION_ERROR')
  const accepted = await execute<{ group: SharedModifierGroup }>(owner, { ...create, operationId: randomUUID(), expectedVersion: 2, options: [{ ...group.options[0], name: 'Avena nueva' }] })
  expect(accepted).toBeTruthy(); expect(product.version).toBe(1)
  const canonical = accepted.group
  const referenced = await execute<Product>(owner, saveProduct({ ...emptyDetails(), modifierSets: [{ id: canonical.id, libraryId: canonical.id, name: canonical.name, min: canonical.min, max: canonical.max, options: canonical.options }, { id: randomUUID(), name: 'Preparación de avena', parentOptionId: option, min: 0, max: 1, options: [{ id: randomUUID(), name: 'Caliente', priceCents: 0 }] }] }))
  await expect(execute(owner, { ...create, operationId: randomUUID(), expectedVersion: 3, options: [{ id: randomUUID(), name: 'Soja', priceCents: 0 }] })).rejects.toThrow('VALIDATION_ERROR')
  const catalog = (await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products
  expect(catalog.find(item => item.id === referenced.id)).toEqual(referenced)
  expect((await execute<{ groups: SharedModifierGroup[] }>(owner, { command: 'modifier_groups' })).groups[0]).toMatchObject({ version: 3, options: canonical.options })
 })
})
async function selection(product: Product, chosen: unknown) {
 return (await db.query<{ result: { price: number; label: string } }>('select app_private.product_selection(p,$2::jsonb) result from app_private.products p where id=$1', [product.id, JSON.stringify(chosen)])).rows[0].result
}

function saveProduct(details: ProductDetails = emptyDetails(), priceCents = 11600): SaveProduct {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Latte sintético', category: 'Café', priceCents, details }
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
