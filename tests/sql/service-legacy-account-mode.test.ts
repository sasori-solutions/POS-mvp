import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, DiningTable, OperationalOrder } from '../../src/lib/operations-contracts'
import type { ServiceResponses } from '../../src/lib/service-contracts'
type Actor = { business: string; user: string; auth: string; employee: string; token: string; key: string }
let db: PGlite
describe('legacy effective account mode in service continuation', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec('create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);')
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60000)
  afterAll(async () => db?.close())

  it.each(['missing', 'null', 'true', 'false'])('uses the effective %s flag after full payment without changing finalized receipts or authorization', async flag => {
    const owner = await actor()
    if (flag !== 'missing' && flag !== 'false') await db.query("update app_private.businesses set profile=jsonb_set(profile,'{accountsEnabled}',$2::jsonb) where id=$1", [owner.business, flag])
    const table = await pos<DiningTable>(owner, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa sintética', active: true })
    const product = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Americano sintético', category: '', priceCents: 3500 })
    let order = await pos<OperationalOrder>(owner, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Mesa sintética', orderKind: 'service', tableId: table.id, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: 3500, quantity: 1, note: '' }] })
    order = await pos(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
    const attempt = await pos<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, paymentMethod: 'cash', items: [{ lineId: order.items[0].lineId, quantity: 1 }] })
    const paid = await pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(owner, { command: 'record_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true })
    expect(paid.order).toMatchObject({ status: 'closed', frozen: true, paidCents: 3500, balanceCents: 0 })
    const receipt = await pos<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! })
    if (flag === 'false') await db.query("update app_private.businesses set profile=jsonb_set(profile,'{accountsEnabled}','false') where id=$1", [owner.business])
    const command = { command: 'continue_service_order' as const, operationId: randomUUID(), sourceOrderId: paid.order.id, expectedRevision: paid.order.revision, orderId: randomUUID(), name: 'Consumo posterior' }
    if (flag === 'false') {
      await expect(pos(owner, command)).rejects.toThrow('PERMISSION_DENIED')
      expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.operational_orders where business_id=$1', [owner.business])).rows[0].count).toBe(1)
      expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.pos_operations where business_id=$1 and operation_id=$2', [owner.business, command.operationId])).rows[0].count).toBe(0)
    } else {
      const continued = await pos<ServiceResponses['continue_service_order']>(owner, command)
      expect(continued.order).toMatchObject({ id: command.orderId, frozen: false, status: 'open', orderKind: 'service', items: [], balanceCents: 0 })
      expect(continued.visit.orders).toEqual([paid.order, continued.order])
      await db.query("update app_private.businesses set profile=jsonb_set(profile,'{accountsEnabled}','false') where id=$1", [owner.business])
      expect(await pos(owner, command)).toEqual(continued)
      await db.query('update app_private.employees set active=false where business_id=$1 and id=$2', [owner.business, owner.employee])
      await expect(pos(owner, command)).rejects.toThrow('BUSINESS_ACCESS_DENIED')
      await db.query('update app_private.employees set active=true where business_id=$1 and id=$2', [owner.business, owner.employee])
    }
    expect(await pos(owner, { command: 'sale', saleId: receipt.id })).toEqual(receipt)
    expect(await pos(owner, { command: 'order', orderId: paid.order.id })).toEqual(paid.order)
    for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'app_private.pos_command_before_catalog_bulk(uuid,uuid,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
  })
})
async function actor(): Promise<Actor> {
  const owner: Actor = { business: randomUUID(), user: randomUUID(), auth: randomUUID(), employee: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), key: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [owner.user]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [owner.auth, owner.user])
  await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Hermosillo','{"paymentMethods":["cash"]}')`, [owner.business])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [owner.business, owner.user])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Persona sintética','owner')", [owner.employee, owner.business, owner.user])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [owner.business, owner.user, owner.auth, owner.token])
  await pos(owner, { command: 'activate_operations', operationId: randomUUID() }); await pos(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  return owner
}
async function pos<T = unknown>(owner: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [owner.user, owner.auth, JSON.stringify({ action: 'pos', businessId: owner.business, operatorToken: owner.token, ...command }), owner.key, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
