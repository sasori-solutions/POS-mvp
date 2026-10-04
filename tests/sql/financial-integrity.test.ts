import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, OperationalOrder, OperationsResponses } from '../../src/lib/operations-contracts'
import { emptyDetails } from '../../src/lib/product-details'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
type Queryable = Pick<Transaction, 'query'>
type Slice = { quantity: number; totalCents: number; discountCents: number; taxCents: number }
type RecordPaymentResult = OperationsResponses['record_checkout']

describe('financial conservation and immutable settlement', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create role authenticator noinherit; grant service_role to authenticator;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('matches a separate BigInt oracle at rounding boundaries and maximum quantities/prices', async () => {
    const cases: { line: Record<string, unknown>; quantity: number; expected: Slice }[] = []
    for (const quantity of [1, 2, 3, 7, 999]) for (const price of [0, 1, 17, 1001, 99999999]) {
      const gross = BigInt(quantity) * BigInt(price)
      for (const discount of new Set([0n, gross / 3n, gross > 0n ? gross - 1n : 0n, gross])) {
        const total = gross - discount
        for (const rate of [0, 800, 1600]) {
          const tax = roundHalfUp(total * BigInt(rate), 10000n + BigInt(rate))
          for (const paid of new Set([0, 1, Math.floor(quantity / 2), quantity - 1])) {
            if (paid >= quantity) continue
            for (const count of new Set([1, Math.max(1, Math.floor((quantity - paid) / 2)), quantity - paid])) {
              const discountAt = (units: number) => discount * BigInt(units) / BigInt(quantity)
              const netAt = (units: number) => BigInt(price) * BigInt(units) - discountAt(units)
              const sliceDiscount = discountAt(paid + count) - discountAt(paid)
              const sliceTotal = netAt(paid + count) - netAt(paid)
              const sliceTax = total === 0n ? 0n : tax * netAt(paid + count) / total - tax * netAt(paid) / total
              cases.push({
                line: { id: randomUUID(), product_id: randomUUID(), name: 'Artículo sintético', category: '', selection_label: '', quantity, paid_quantity: paid, unit_price_cents: price, discount_cents: Number(discount), total_cents: Number(total), tax_cents: Number(tax), tax_bps: rate, tax_treatment: rate === 1600 ? 'vat_16' : rate === 800 ? 'border_8' : 'unconfigured' },
                quantity: count,
                expected: { quantity: count, totalCents: Number(sliceTotal), discountCents: Number(sliceDiscount), taxCents: Number(sliceTax) },
              })
            }
          }
        }
      }
    }
    expect(cases.length).toBeGreaterThan(1000)
    for (let offset = 0; offset < cases.length; offset += 300) {
      const batch = cases.slice(offset, offset + 300)
      const results = await db.query<{ slice: Slice }>(`select app_private.ops_slice(
        jsonb_populate_record(null::app_private.order_lines, sample->'line'), (sample->>'quantity')::integer) as slice
        from jsonb_array_elements($1::jsonb) sample`, [JSON.stringify(batch.map(({ line, quantity }) => ({ line, quantity })))])
      for (const [index, result] of results.rows.entries()) {
        expect(result.slice).toMatchObject(batch[index].expected)
        expect(result.slice.taxCents).toBeLessThanOrEqual(result.slice.totalCents)
        expect(result.slice.totalCents).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('allocates every fixed and percentage cent deterministically across different line sizes', async () => {
    const actor = await fixture()
    const products = await Promise.all([1, 17, 1001, 201].map(price => product(actor, price)))
    for (const discount of [{ kind: 'fixed', value: 1 }, { kind: 'fixed', value: 997 }, { kind: 'percent', value: 3333 }, { kind: 'percent', value: 10000 }] as const) {
      let order = await createOrder(actor, products.map((item, index) => ({ product: item, quantity: index + 1 })))
      order = await execute(actor, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { ...discount, reason: 'Reparto exacto sintético' } })
      const gross = BigInt(order.grossCents)
      const amount = discount.kind === 'fixed' ? BigInt(discount.value) : roundHalfUp(gross * BigInt(discount.value), 10000n)
      const shares = order.items.map(line => ({ id: line.lineId, base: amount * BigInt(line.grossCents) / gross, remainder: amount * BigInt(line.grossCents) % gross }))
      const leftovers = amount - shares.reduce((sum, share) => sum + share.base, 0n)
      shares.sort((left, right) => left.remainder === right.remainder ? left.id.localeCompare(right.id) : left.remainder > right.remainder ? -1 : 1)
      const expected = new Map(shares.map((share, index) => [share.id, share.base + (BigInt(index) < leftovers ? 1n : 0n)]))
      for (const line of order.items) expect(BigInt(line.discountCents)).toBe(expected.get(line.lineId))
      expect(BigInt(order.discountCents)).toBe(amount)
      expect(order.items.reduce((sum, line) => sum + line.totalCents, 0)).toBe(order.totalCents)
      expect(order.grossCents - order.discountCents).toBe(order.totalCents)
    }
  })

  it('conserves line totals, tax and quantity across several receipts, refunds and a cash closing', async () => {
    const actor = await fixture(127)
    const products = await Promise.all([1, 1001].map(price => product(actor, price)))
    let order = await createOrder(actor, products.map(item => ({ product: item, quantity: 3 })))
    order = await execute(actor, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'percent', value: 3333, reason: 'Prorrateo sintético' } })
    const original = order
    const receipts: CheckoutAttempt[] = []
    for (let index = 0; index < 3; index++) {
      const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: order.items.map(line => ({ lineId: line.lineId, quantity: 1 })), paymentMethod: 'cash' })
      const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const }
      const paid = await execute<RecordPaymentResult>(actor, command)
      expect(await execute(actor, command)).toEqual(paid)
      receipts.push(paid.attempt)
      order = paid.order
    }
    expect(order).toMatchObject({ status: 'closed', balanceCents: 0, paidCents: original.totalCents })
    expect(receipts.reduce((sum, receipt) => sum + receipt.totalCents, 0)).toBe(original.totalCents)
    expect(receipts.reduce((sum, receipt) => sum + receipt.discountCents, 0)).toBe(original.discountCents)
    expect(receipts.reduce((sum, receipt) => sum + receipt.taxCents, 0)).toBe(original.taxCents)
    let refund = await execute<CheckoutAttempt>(actor, { command: 'prepare_reversal', operationId: randomUUID(), saleId: receipts[1].saleId!, reason: 'Corrección sintética' })
    refund = await execute(actor, { command: 'start_checkout', operationId: randomUUID(), attemptId: refund.id, expectedRevision: refund.revision })
    await execute(actor, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: refund.id, expectedRevision: refund.revision, resolution: 'complete', confirmed: true, reason: 'Devolución sintética' })
    const shift = (await execute<{ shifts: { id: string; revision: number }[] }>(actor, { command: 'shifts' })).shifts[0]
    const closing = await execute<{ id: string; revision: number }>(actor, { command: 'begin_shift_close', operationId: randomUUID(), shiftId: shift.id, expectedRevision: shift.revision })
    const expectedCents = 127 + original.totalCents - receipts[1].totalCents
    expect(await execute(actor, { command: 'close_shift', operationId: randomUUID(), shiftId: closing.id, expectedRevision: closing.revision, countedCents: expectedCents })).toMatchObject({ expectedCents, differenceCents: 0 })
    const mismatches = await db.query<{ count: number }>(`select count(*)::integer as count from app_private.sales s
      where s.business_id=$1 and (s.total_cents <> (select sum(i.total_cents) from app_private.sale_items i where i.business_id=s.business_id and i.sale_id=s.id)
      or s.item_count <> (select sum(i.quantity) from app_private.sale_items i where i.business_id=s.business_id and i.sale_id=s.id))`, [actor.businessId])
    expect(mismatches.rows[0].count).toBe(0)
  })

  it.each(['total_cents', 'discount_cents', 'tax_cents'] as const)('rejects a corrupted prepared %s before any financial effect can commit', async column => {
    const actor = await fixture(), item = await product(actor, 1001), order = await createOrder(actor, [{ product: item, quantity: 2 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    await expect(db.transaction(async transaction => {
      await transaction.query(`update app_private.checkout_attempts set ${column}=${column}+1 where business_id=$1 and id=$2`, [actor.businessId, quote.id])
      await execute(actor, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }, transaction)
    })).rejects.toThrow()
    expect(await execute(actor, { command: 'attempt', attemptId: quote.id })).toMatchObject({ status: 'prepared', saleId: null, totalCents: quote.totalCents, taxCents: quote.taxCents, discountCents: quote.discountCents })
    expect(await execute(actor, { command: 'order', orderId: order.id })).toMatchObject({ paidCents: 0, items: [{ paidQuantity: 0 }] })
    expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.sales where business_id=$1', [actor.businessId])).rows[0].count).toBe(0)
  })

  it('rejects rewriting finalized receipt amounts and preserves the original immutable response', async () => {
    const actor = await fixture(), item = await product(actor, 1001), order = await createOrder(actor, [{ product: item, quantity: 1 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const }
    const paid = await execute<RecordPaymentResult>(actor, command)
    await expect(db.query('update app_private.sales set total_cents=total_cents+1 where business_id=$1 and id=$2', [actor.businessId, paid.attempt.saleId])).rejects.toThrow()
    await expect(db.query('update app_private.sale_items set unit_price_cents=unit_price_cents+1,total_cents=total_cents+1 where business_id=$1 and sale_id=$2', [actor.businessId, paid.attempt.saleId])).rejects.toThrow()
    expect(await execute(actor, command)).toEqual(paid)
    expect(await execute(actor, { command: 'sale', saleId: paid.attempt.saleId! })).toMatchObject({ totalCents: 1001, items: [{ unitPriceCents: 1001, totalCents: 1001 }] })
  })

  it.each([0, 1001])('freezes the accepted order basis and reconciles paid quantities even for a %s-cent receipt', async priceCents => {
    const actor = await fixture(), item = await product(actor, priceCents), original = await createOrder(actor, [{ product: item, quantity: 2 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: original.id, expectedRevision: original.revision, items: [{ lineId: original.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    const paid = await execute<RecordPaymentResult>(actor, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
    expect(paid.order).toMatchObject({ status: 'open', frozen: true, items: [{ paidQuantity: 1 }] })
    await expect(db.query('update app_private.operational_orders set frozen=false where business_id=$1 and id=$2', [actor.businessId, original.id])).rejects.toThrow()
    await expect(db.query('update app_private.order_lines set paid_quantity=0 where business_id=$1 and order_id=$2', [actor.businessId, original.id])).rejects.toThrow()
    await expect(db.query('update app_private.order_lines set tax_cents=tax_cents+1 where business_id=$1 and order_id=$2', [actor.businessId, original.id])).rejects.toThrow()
    await expect(db.query('delete from app_private.order_lines where business_id=$1 and order_id=$2', [actor.businessId, original.id])).rejects.toThrow()
    expect(await execute(actor, { command: 'order', orderId: original.id })).toEqual(paid.order)
  })

  it('rejects a receipt snapshot drift that preserves every aggregate amount', async () => {
    const actor = await fixture(), item = await product(actor, 1001), order = await createOrder(actor, [{ product: item, quantity: 1 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    await db.exec(`create function app_private.synthetic_wrong_receipt() returns trigger language plpgsql set search_path='' as $$ begin new.name:='Nombre incorrecto sintético'; return new; end; $$;
      create trigger synthetic_wrong_receipt before insert on app_private.sale_items for each row execute function app_private.synthetic_wrong_receipt();`)
    try {
      await expect(execute(actor, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })).rejects.toThrow()
      expect(await execute(actor, { command: 'attempt', attemptId: quote.id })).toMatchObject({ status: 'prepared', saleId: null })
      expect(await execute(actor, { command: 'order', orderId: order.id })).toMatchObject({ paidCents: 0, items: [{ paidQuantity: 0 }] })
      expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.sales where business_id=$1', [actor.businessId])).rows[0].count).toBe(0)
    } finally {
      await db.exec('drop trigger synthetic_wrong_receipt on app_private.sale_items; drop function app_private.synthetic_wrong_receipt();')
    }
  })

  it('preserves historical money after employee erasure and complete business deletion', async () => {
    const actor = await fixture(), item = await product(actor, 1001), order = await createOrder(actor, [{ product: item, quantity: 1 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    const paid = await execute<RecordPaymentResult>(actor, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
    await expect(db.query('update app_private.sales set employee_id=null where business_id=$1 and id=$2', [actor.businessId, paid.attempt.saleId])).rejects.toThrow()
    await db.query('delete from app_private.employees where business_id=$1 and id=$2', [actor.businessId, actor.employeeId])
    expect((await db.query<{ total_cents: number; employee_id: null; operator_name: string }>('select total_cents,employee_id,operator_name from app_private.sales where business_id=$1 and id=$2', [actor.businessId, paid.attempt.saleId])).rows[0]).toEqual({ total_cents: 1001, employee_id: null, operator_name: 'Operador sintético' })
    expect((await db.query<{ actor_id: null; actor_identity: string }>('select actor_id,actor_identity from app_private.checkout_attempts where business_id=$1 and id=$2', [actor.businessId, quote.id])).rows[0]).toEqual({ actor_id: null, actor_identity: actor.employeeId })
    await db.query('delete from app_private.businesses where id=$1', [actor.businessId])
    expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.sales where business_id=$1', [actor.businessId])).rows[0].count).toBe(0)
  })

  it('reports a coherent private ledger without browser grants or identity data', async () => {
    const checks = (await db.query<{ checks: Record<string, number> }>('select app_private.ops_financial_ledger_check() as checks')).rows[0].checks
    expect(checks).toEqual({ invalidQuotes: 0, invalidSales: 0, invalidCompletedAttempts: 0, invalidReversals: 0, invalidClosedShifts: 0, invalidPendingSnapshots: 0, invalidOrders: 0 })
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'app_private.ops_financial_ledger_check()','EXECUTE') as allowed", [role])).rows[0].allowed).toBe(false)
    }
  })

  // PGlite checks the resulting role/privilege contract. Reproducing the original
  // invoker failure at PostgREST COMMIT requires the real loopback integration;
  // this embedded engine did not reproduce that negative control.
  it.each(['postgres', 'service_role', 'authenticator'] as const)('reconciles deferred payment and adjustment triggers at COMMIT as %s without private grants', async commitRole => {
    const actor = await fixture(), item = await product(actor, 1001), order = await createOrder(actor, [{ product: item, quantity: 1 }])
    const quote = await execute<CheckoutAttempt>(actor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    const command = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const }
    const paid = await db.transaction(async transaction => {
      if (commitRole !== 'postgres') await transaction.exec('set local role service_role')
      const result = await execute<RecordPaymentResult>(actor, command, transaction)
      if (commitRole === 'authenticator') await transaction.exec('set local role authenticator')
      expect((await transaction.query<{ role: string }>('select current_user as role')).rows[0].role).toBe(commitRole)
      return result
    })
    expect(paid.order).toMatchObject({ status: 'closed', paidCents: 1001 })
    expect(await execute(actor, command)).toEqual(paid)
    const cancelledOrder = await createOrder(actor, [{ product: item, quantity: 1 }])
    await db.transaction(async transaction => {
      if (commitRole !== 'postgres') await transaction.exec('set local role service_role')
      expect(await execute(actor, { command: 'cancel_order', operationId: randomUUID(), orderId: cancelledOrder.id, expectedRevision: cancelledOrder.revision, reason: 'Cancelación sintética' }, transaction)).toMatchObject({ status: 'cancelled', balanceCents: 0 })
      if (commitRole === 'authenticator') await transaction.exec('set local role authenticator')
    })
    if (commitRole !== 'postgres') {
      expect((await db.query<{ allowed: boolean }>("select has_schema_privilege($1,'app_private','USAGE') as allowed", [commitRole])).rows[0].allowed).toBe(false)
      await expect(db.transaction(async transaction => {
        await transaction.exec(`set local role ${commitRole}`)
        await transaction.query('select * from app_private.sales')
      })).rejects.toThrow(/permission denied/)
    }
    const triggerFunctions = await db.query<{ name: string; owner: string; definer: boolean; config: string[] }>(`select p.proname as name, pg_get_userbyid(p.proowner) as owner,p.prosecdef as definer,p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in ('ops_check_financial_graph','ops_check_adjustment_order') order by p.proname`)
    expect(triggerFunctions.rows).toHaveLength(2)
    for (const entrypoint of triggerFunctions.rows) expect(entrypoint).toMatchObject({ owner: 'postgres', definer: true, config: ['search_path=""'] })
  })

})

function roundHalfUp(numerator: bigint, denominator: bigint) { return (2n * numerator + denominator) / (2n * denominator) }
async function fixture(openingCents = 0): Promise<Actor> {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash","card_external","transfer"]}')`, [actor.businessId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Operador sintético','owner')", [actor.employeeId, actor.businessId, actor.userId])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [actor.businessId, actor.userId, actor.sessionId, actor.token])
  await execute(actor, { command: 'activate_operations', operationId: randomUUID() })
  await execute(actor, { command: 'open_shift', operationId: randomUUID(), openingCents })
  return actor
}
async function execute<T = unknown>(actor: Actor, command: PosCommand, connection: Queryable = db): Promise<T> {
  const result = (await connection.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result", [actor.userId, actor.sessionId, JSON.stringify({ action: 'pos', businessId: actor.businessId, operatorToken: actor.token, ...command }), actor.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
async function product(actor: Actor, priceCents: number) {
  return execute<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents, details: { ...emptyDetails(), taxBps: 1600, taxTreatment: 'vat_16' } })
}
async function createOrder(actor: Actor, items: { product: Product; quantity: number }[]) {
  return execute<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, items: items.map(({ product: item, quantity }) => ({ lineId: randomUUID(), productId: item.id, quantity, unitPriceCents: item.priceCents, version: item.version, note: '' })) })
}
