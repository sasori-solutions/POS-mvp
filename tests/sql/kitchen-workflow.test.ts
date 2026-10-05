import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

type Actor = { businessId: string; userId: string; sessionId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite
describe('persisted three-stage kitchen workflow', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  test('advances queued to preparing to delivered and replays the original accepted action exactly', async () => {
    const owner = await actor(), { batch, order } = await work(owner)
    const command = { command: 'set_kitchen_status' as const, operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'preparing' as const }
    const preparing = await execute<KitchenBatch>(owner, command)
    expect(preparing).toMatchObject({ status: 'preparing', revision: batch.revision + 1, items: batch.items })
    const delivered = await execute<KitchenBatch>(owner, { ...command, operationId: randomUUID(), expectedRevision: preparing.revision, status: 'delivered' })
    expect(delivered).toMatchObject({ status: 'delivered', revision: preparing.revision + 1 })
    expect(await execute(owner, command)).toEqual(preparing)
    expect(await execute(owner, { command: 'order', orderId: order.id })).toEqual(order)
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.sales where business_id=$1', [owner.businessId])).rows[0].count).toBe(0)
  })

  test('rejects stale revisions, backwards transitions and a changed payload using the same UUID', async () => {
    const owner = await actor(), { batch } = await work(owner)
    const command = { command: 'set_kitchen_status' as const, operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'preparing' as const }
    const preparing = await execute<KitchenBatch>(owner, command)
    await expect(execute(owner, { ...command, status: 'delivered' })).rejects.toThrow('OPERATION_CONFLICT')
    await expect(execute(owner, { ...command, operationId: randomUUID(), status: 'delivered' })).rejects.toThrow('BATCH_CHANGED')
    const delivered = await execute<KitchenBatch>(owner, { ...command, operationId: randomUUID(), expectedRevision: preparing.revision, status: 'delivered' })
    await expect(execute(owner, { ...command, operationId: randomUUID(), expectedRevision: delivered.revision })).rejects.toThrow('BATCH_CHANGED')
  })

  test('legacy direct completion stays compatible and ready work can complete', async () => {
    const owner = await actor(), first = await work(owner), second = await work(owner)
    expect(await execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: first.batch.id, expectedRevision: first.batch.revision, status: 'delivered' })).toMatchObject({ status: 'delivered' })
    let batch = await execute<KitchenBatch>(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: second.batch.id, expectedRevision: second.batch.revision, status: 'preparing' })
    batch = await execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'ready' })
    expect(await execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'delivered' })).toMatchObject({ status: 'delivered' })
  })

  test('fully cancelled work cannot start and cancellation notices are acknowledged independently', async () => {
    const owner = await actor(), { batch, order } = await work(owner)
    await execute(owner, { command: 'cancel_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: 'Cancelación sintética' })
    const batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
    const cancelled = batches.find(item => item.id === batch.id)!, notice = batches.find(item => item.kind === 'cancellation')!
    expect(cancelled.fullyCancelled).toBe(true)
    for (const status of ['preparing', 'delivered'] as const) await expect(execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: cancelled.id, expectedRevision: cancelled.revision, status })).rejects.toThrow('BATCH_CHANGED')
    await expect(execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: notice.id, expectedRevision: notice.revision, status: 'preparing' })).rejects.toThrow('BATCH_CHANGED')
    expect(await execute(owner, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: notice.id, expectedRevision: notice.revision, status: 'delivered' })).toMatchObject({ status: 'delivered' })
  })

  test('cross-business and read-only kitchen actors cannot advance a batch', async () => {
    const owner = await actor(), other = await actor(), reader = await actor(owner.businessId, ['kitchen.read']), { batch } = await work(owner)
    const command = { command: 'set_kitchen_status' as const, operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'preparing' as const }
    await expect(execute(other, command)).rejects.toThrow('BATCH_CHANGED')
    await expect(execute(reader, command)).rejects.toThrow('PERMISSION_DENIED')
    expect((await execute<{ batches: KitchenBatch[] }>(reader, { command: 'kitchen' })).batches.find(item => item.id === batch.id)?.status).toBe('queued')
  })
})

async function actor(businessId?: string, permissions: string[] = []): Promise<Actor> {
  const value = { businessId: businessId ?? randomUUID(), userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  const role = businessId ? 'cashier' : 'owner'
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
async function work(owner: Actor) {
  const product = await execute<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001 })
  let order = await execute<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity: 1, note: '' }] })
  order = await execute(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  const batch = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches.find(item => item.orderId === order.id)!
  return { batch, order }
}
