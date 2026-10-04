import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { BalanceWaiver, CheckoutAttempt, OperationalOrder, OperationsResponses } from '../../src/lib/operations-contracts'
import { emptyDetails } from '../../src/lib/product-details'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }

describe('append-only financial adjustment and replay history', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('cancels the exact remaining discounted prefix after a partial payment and replays one original result', async () => {
    const actor = await fixture(), item = await product(actor), original = await order(actor, item, 3)
    const discounted = await execute<OperationalOrder>(actor, { command: 'set_order_discount', operationId: randomUUID(), orderId: original.id, expectedRevision: original.revision, discount: { kind: 'fixed', value: 2, reason: 'Centavos sintéticos' } })
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: discounted.id, expectedRevision: discounted.revision, paymentMethod: 'cash', items: [{ lineId: discounted.items[0].lineId, quantity: 1 }] })
    const paid = await execute<OperationsResponses['record_checkout']>(actor, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
    const command = { command: 'cancel_order' as const, operationId: randomUUID(), orderId: paid.order.id, expectedRevision: paid.order.revision, reason: 'Cancelar unidades pendientes' }
    const cancelled = await execute<OperationalOrder>(actor, command)
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledCents: 2000, paidCents: 1001, balanceCents: 0 })
    expect(await execute(actor, command)).toEqual(cancelled)
    const history = (await db.query<{ amount_cents: number; items: { quantity: number; totalCents: number; taxCents: number }[] }>('select amount_cents,items from app_private.order_cancellations where business_id=$1 and order_id=$2', [actor.businessId, original.id])).rows
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ amount_cents: 2000, items: [{ quantity: 2, totalCents: 2000 }] })
  })

  it('rejects cancellation snapshot rewrites, manual actor erasure and deletion without a business cascade', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item)
    await execute(actor, { command: 'cancel_order', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, reason: 'Cancelación sintética' })
    for (const set of ["reason='Reescrito'", 'amount_cents=amount_cents+1', 'actor_id=null', "actor_name='Otra persona'", "created_at=created_at-interval '1 day'"]) {
      await expect(db.query(`update app_private.order_cancellations set ${set} where business_id=$1 and order_id=$2`, [actor.businessId, account.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
    }
    await expect(db.query('delete from app_private.order_cancellations where business_id=$1 and order_id=$2', [actor.businessId, account.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
  })

  it('rejects cancellation rows with invalid algebra or a valid partial snapshot masquerading as the full balance', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item, 3)
    const snapshots = await remaining(actor, account)
    const malformed = [{ ...snapshots[0], totalCents: 3002 }]
    const partial = [{ ...snapshots[0], quantity: 1, totalCents: 1001, taxCents: 138 }]
    for (const [amount, items] of [[3002, malformed], [1001, partial], [3004, snapshots]] as const) {
      await expect(db.query('insert into app_private.order_cancellations(business_id,order_id,amount_cents,reason,items,actor_id,actor_name) values($1,$2,$3,$4,$5::jsonb,$6,$7)', [actor.businessId, account.id, amount, 'Fila inválida sintética', JSON.stringify(items), actor.employeeId, 'Persona sintética'])).rejects.toThrow('FINANCIAL_INTEGRITY')
    }
    expect((await execute<OperationalOrder>(actor, { command: 'order', orderId: account.id })).balanceCents).toBe(3003)
  })

  it('completes a prepared waiver once, preserves its financial snapshot and rejects all finalized rewrites', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item, 2)
    const prepared = await execute<BalanceWaiver>(actor, { command: 'prepare_waiver', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, reason: 'Cortesía sintética' })
    const command = { command: 'confirm_waiver' as const, operationId: randomUUID(), waiverId: prepared.id, expectedRevision: prepared.revision, confirmed: true as const }
    const completed = await execute<BalanceWaiver>(actor, command)
    expect(completed).toMatchObject({ amountCents: 2002, status: 'completed', revision: 2 })
    expect(await execute(actor, command)).toEqual(completed)
    expect(await execute(actor, { command: 'order', orderId: account.id })).toMatchObject({ status: 'waived', waivedCents: 2002, balanceCents: 0 })
    for (const set of ["reason='Reescrito'", 'amount_cents=amount_cents-1', 'actor_id=null', 'resolver_id=null', "resolver_name='Otra persona'", "status='prepared'", "timezone='UTC'", "resolved_at=resolved_at-interval '1 day'"]) {
      await expect(db.query(`update app_private.balance_waivers set ${set} where business_id=$1 and id=$2`, [actor.businessId, prepared.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
    }
    await expect(db.query('delete from app_private.balance_waivers where business_id=$1 and id=$2', [actor.businessId, prepared.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
  })

  it('keeps an abandoned prepared waiver immutable and prevents completing it after the balance changes', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item, 2)
    const prepared = await execute<BalanceWaiver>(actor, { command: 'prepare_waiver', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, reason: 'Propuesta original' })
    await expect(db.query("update app_private.balance_waivers set reason='Otro motivo' where business_id=$1 and id=$2", [actor.businessId, prepared.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
    const discounted = await execute<OperationalOrder>(actor, { command: 'set_order_discount', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, discount: { kind: 'fixed', value: 1, reason: 'Cambió el saldo' } })
    await expect(execute(actor, { command: 'confirm_waiver', operationId: randomUUID(), waiverId: prepared.id, expectedRevision: prepared.revision, confirmed: true })).rejects.toThrow('WAIVER_CHANGED')
    await expect(db.query("update app_private.balance_waivers set status='completed',revision=revision+1,resolver_id=$3,resolver_name='Persona sintética',resolved_at=clock_timestamp() where business_id=$1 and id=$2", [actor.businessId, prepared.id, actor.employeeId])).rejects.toThrow('FINANCIAL_INTEGRITY')
    expect(discounted.balanceCents).toBe(2001)
    const fresh = await execute<BalanceWaiver>(actor, { command: 'prepare_waiver', operationId: randomUUID(), orderId: account.id, expectedRevision: discounted.revision, reason: 'Propuesta actual' })
    expect(await execute(actor, { command: 'confirm_waiver', operationId: randomUUID(), waiverId: fresh.id, expectedRevision: fresh.revision, confirmed: true })).toMatchObject({ status: 'completed', amountCents: 2001 })
  })

  it('rejects direct finalized waiver insertion without the validated prepared transition', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item)
    const items = await remaining(actor, account)
    await expect(db.query("insert into app_private.balance_waivers(business_id,order_id,order_revision,status,amount_cents,reason,items,actor_id,actor_identity,operator_name,timezone,resolver_id,resolver_name,resolved_at) values($1,$2,$3,'completed',$4,'Directo',$5::jsonb,$6,$6,'Persona sintética','America/Mexico_City',$6,'Persona sintética',clock_timestamp())", [actor.businessId, account.id, account.revision, account.balanceCents, JSON.stringify(items), actor.employeeId])).rejects.toThrow('FINANCIAL_INTEGRITY')
  })

  it('protects accepted operation UUIDs, fingerprints and exact replay responses independently of caller settings', async () => {
    const actor = await fixture(), item = await product(actor), operationId = randomUUID()
    const command = { command: 'save_order' as const, operationId, orderId: randomUUID(), expectedRevision: null, name: 'Cuenta original', tableId: null, items: [{ lineId: randomUUID(), productId: item.id, quantity: 1, unitPriceCents: item.priceCents, version: item.version, note: '' }] }
    const accepted = await execute(actor, command)
    await db.query("select set_config('app_private.financial_history_cleanup','true',false),set_config('app_private.allow_financial_updates','true',false)")
    for (const set of ["result='{}'::jsonb", "payload_fingerprint=decode('00','hex')", 'actor_id=null', "created_at=created_at-interval '1 day'"]) {
      await expect(db.query(`update app_private.pos_operations set ${set} where business_id=$1 and operation_id=$2`, [actor.businessId, operationId])).rejects.toThrow('FINANCIAL_INTEGRITY')
    }
    await expect(db.query('delete from app_private.pos_operations where business_id=$1 and operation_id=$2', [actor.businessId, operationId])).rejects.toThrow('FINANCIAL_INTEGRITY')
    expect(await execute(actor, command)).toEqual(accepted)
  })

  it('protects the preparation history used by kitchen and cancellation authorization', async () => {
    const actor = await fixture(), item = await product(actor), account = await order(actor, item)
    for (const set of ["kind='confirm_waiver'", "payload='{}'::jsonb", 'actor_id=null', "actor_name='Otra persona'", "created_at=created_at-interval '1 day'"]) {
      await expect(db.query(`update app_private.order_events set ${set} where business_id=$1 and order_id=$2`, [actor.businessId, account.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
    }
    await expect(db.query('delete from app_private.order_events where business_id=$1 and order_id=$2', [actor.businessId, account.id])).rejects.toThrow('FINANCIAL_INTEGRITY')
  })

  it('allows actual employee deletion to null only actor references while preserving amounts and operation UUIDs', async () => {
    const owner = await fixture(), cashier = await fixture(owner.businessId), item = await product(owner), account = await order(cashier, item)
    await execute(cashier, { command: 'cancel_order', operationId: randomUUID(), orderId: account.id, expectedRevision: account.revision, reason: 'Empleado sintético' })
    const before = (await db.query<{ row: Record<string, unknown> }>('select to_jsonb(c) as row from app_private.order_cancellations c where business_id=$1 and order_id=$2', [owner.businessId, account.id])).rows[0].row
    const payload = { action: 'delete_employee', businessId: owner.businessId, operatorToken: owner.token, employeeId: cashier.employeeId, operationId: randomUUID() }
    const result = (await db.query<{ result: { data?: unknown; error?: { code: string } } }>("select public.account_secure($1,$2,'delete_employee',$3::jsonb,$4,$5) as result", [owner.userId, owner.sessionId, JSON.stringify(payload), owner.keyHash, randomUUID()])).rows[0].result
    expect(result.error).toBeUndefined()
    const after = (await db.query<{ row: Record<string, unknown> }>('select to_jsonb(c) as row from app_private.order_cancellations c where business_id=$1 and order_id=$2', [owner.businessId, account.id])).rows[0].row
    expect(after).toEqual({ ...before, actor_id: null })
    expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.pos_operations where business_id=$1 and actor_id=$2', [owner.businessId, cashier.employeeId])).rows[0].count).toBe(0)
    expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.order_events where business_id=$1 and order_id=$2 and actor_id is null', [owner.businessId, account.id])).rows[0].count).toBeGreaterThan(0)
  })

  it('preserves complete tenant cascades and keeps private audit helpers inaccessible to browser roles', async () => {
    const actor = await fixture(), item = await product(actor), cancelled = await order(actor, item), waived = await order(actor, item)
    await execute(actor, { command: 'cancel_order', operationId: randomUUID(), orderId: cancelled.id, expectedRevision: cancelled.revision, reason: 'Cancelado sintético' })
    const prepared = await execute<BalanceWaiver>(actor, { command: 'prepare_waiver', operationId: randomUUID(), orderId: waived.id, expectedRevision: waived.revision, reason: 'Condonado sintético' })
    await execute(actor, { command: 'confirm_waiver', operationId: randomUUID(), waiverId: prepared.id, expectedRevision: prepared.revision, confirmed: true })
    expect((await db.query<{ checks: unknown }>('select app_private.ops_financial_adjustment_check() as checks')).rows[0].checks).toEqual({ invalidCancellations: 0, invalidWaivers: 0 })
    const grants = await db.query<{ allowed: boolean }>("select has_function_privilege(role, 'app_private.ops_financial_adjustment_check()', 'EXECUTE') as allowed from unnest(array['anon','authenticated']) role")
    expect(grants.rows.every(row => !row.allowed)).toBe(true)
    await db.query('delete from app_private.businesses where id=$1', [actor.businessId])
    for (const table of ['order_cancellations', 'balance_waivers', 'pos_operations', 'order_events']) expect((await db.query<{ count: number }>(`select count(*)::integer as count from app_private.${table} where business_id=$1`, [actor.businessId])).rows[0].count).toBe(0)
  })
})

async function fixture(businessId?: string): Promise<Actor> {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: businessId ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  if (!businessId) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash","card_external","transfer"]}')`, [actor.businessId])
  const role = businessId ? 'cashier' : 'owner'
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [actor.businessId, actor.userId, role])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [actor.employeeId, actor.businessId, actor.userId, role, businessId ? ['catalog.read', 'sales.create', 'orders.read', 'orders.manage', 'orders.cancel'] : []])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [actor.businessId, actor.userId, actor.sessionId, actor.token])
  if (businessId) {
    await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [actor.businessId, actor.employeeId, actor.keyHash])
    await db.query("update app_private.operator_sessions set employee_device_key_hash=decode($1,'hex') where business_id=$2 and user_id=$3", [actor.keyHash, actor.businessId, actor.userId])
  }
  if (!businessId) {
    await execute(actor, { command: 'activate_operations', operationId: randomUUID() })
    await execute(actor, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  }
  return actor
}
async function execute<T = unknown>(actor: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result", [actor.userId, actor.sessionId, JSON.stringify({ action: 'pos', businessId: actor.businessId, operatorToken: actor.token, ...command }), actor.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
async function product(actor: Actor) {
  return execute<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents: 1001, details: { ...emptyDetails(), taxBps: 1600, taxTreatment: 'vat_16' } })
}
async function order(actor: Actor, item: Product, quantity = 1) {
  return execute<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, items: [{ lineId: randomUUID(), productId: item.id, quantity, unitPriceCents: item.priceCents, version: item.version, note: '' }] })
}
async function remaining(actor: Actor, account: OperationalOrder) {
  return (await db.query<{ items: Record<string, unknown>[] }>('select jsonb_agg(app_private.ops_slice(l,l.quantity-l.paid_quantity) order by l.id) as items from app_private.order_lines l where business_id=$1 and order_id=$2 and quantity>paid_quantity', [actor.businessId, account.id])).rows[0].items
}
