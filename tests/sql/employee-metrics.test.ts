import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BusinessPeriodReport, CashShift, CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import { emptyDetails } from '../../src/lib/product-details'
import { businessDate } from '../../src/lib/reporting'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
const read = { command: 'report_own_period', date: businessDate('America/Mexico_City'), period: 'day' } as const

describe('employee analytics use immutable receipt ownership and live authorization', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('keeps every personal helper private, with an empty search path', async () => {
    for (const signature of ['ops_employee_report_window_base(uuid,uuid,timestamptz,timestamptz)', 'ops_employee_report_window(uuid,uuid,timestamptz,timestamptz)', 'ops_employee_report_series(uuid,uuid,date,date,text,text,timestamptz)', 'ops_employee_period_report_at(uuid,uuid,date,text,timestamptz)']) {
      const name = `app_private.${signature}`
      for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, name])).rows[0].allowed).toBe(false)
      expect((await db.query<{ settings: string[] }>('select proconfig settings from pg_proc where oid=$1::regprocedure', [name])).rows[0].settings).toContain('search_path=""')
    }
    expect((await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated','app_private.ops_employee_reporting_reversals','SELECT') allowed")).rows[0].allowed).toBe(false)
  })

  it('separates two employees with the same name and denies global reports and foreign selectors', async () => {
    const owner = await actor(), grants = ['catalog.read', 'sales.create', 'reports.read_own']
    const first = await actor(owner.businessId, grants), second = await actor(owner.businessId, grants)
    await execute(owner, { command: 'activate_operations', operationId: randomUUID() })
    await execute<CashShift>(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 9000 })
    const product = await item(owner)
    await pay(first, product, 1); await pay(second, product, 3)
    const personal = await execute<BusinessPeriodReport>(first, read)
    expect(personal.totals).toMatchObject({ salesCents: 11600, taxCents: 1600, netCents: 11600, saleCount: 1, cashDifferences: [], operators: [] })
    expect(personal.totals.products).toMatchObject([{ name: product.name, quantity: 1, salesCents: 11600 }])
    expect(personal.series.reduce((sum, point) => sum + point.salesCents, 0)).toBe(11600)
    expect((await execute<BusinessPeriodReport>(second, read)).totals.salesCents).toBe(34800)
    await expect(execute(first, { ...read, command: 'report_period' })).rejects.toThrow('PERMISSION_DENIED')
    for (const extra of [{ employeeId: second.employeeId }, { operatorName: 'Mismo nombre' }, { scope: 'business' }]) await expect(execute(first, { ...read, ...extra } as PosCommand)).rejects.toThrow('VALIDATION_ERROR')
    const other = await actor()
    await expect(execute({ ...first, businessId: other.businessId }, read)).rejects.toThrow()
  })

  it('attributes a refund by the original employee ID, not the person refunding or the historical name', async () => {
    const owner = await actor(), seller = await actor(owner.businessId, ['catalog.read', 'sales.create', 'reports.read_own'])
    await execute(owner, { command: 'activate_operations', operationId: randomUUID() })
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
    const receipt = await pay(seller, await item(owner), 1)
    let refund = await execute<CheckoutAttempt>(owner, { command: 'prepare_reversal', operationId: randomUUID(), saleId: receipt.saleId!, reason: 'Devolución de prueba' })
    refund = await execute(owner, { command: 'start_checkout', operationId: randomUUID(), attemptId: refund.id, expectedRevision: refund.revision })
    await execute(owner, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: refund.id, expectedRevision: refund.revision, resolution: 'complete', confirmed: true, reason: 'Devolución registrada' })
    const personal = await execute<BusinessPeriodReport>(seller, read)
    expect(personal.totals).toMatchObject({ salesCents: 11600, reversalCents: 11600, reversalTaxCents: 1600, netCents: 0 })
    expect(personal.series.reduce((sum, point) => sum + point.reversalCents, 0)).toBe(11600)
    expect((await execute<BusinessPeriodReport>(owner, read)).totals.reversalCents).toBe(0)
  })

  it('requires the explicit own grant and denies an old session after permission revocation', async () => {
    const owner = await actor(), staff = await actor(owner.businessId, ['reports.read_own']), denied = await actor(owner.businessId, [])
    expect((await execute<BusinessPeriodReport>(staff, read)).totals.saleCount).toBe(0)
    await expect(execute(denied, read)).rejects.toThrow('PERMISSION_DENIED')
    await db.query('update app_private.employees set permissions=\'{}\' where id=$1', [staff.employeeId])
    await expect(execute(staff, read)).rejects.toThrow('SESSION_INVALID')
    const remaining = (await db.query<{ permissions: string[] }>('select permissions from app_private.employees where id=$1', [denied.employeeId])).rows[0].permissions
    expect(remaining).not.toContain('reports.read_own')
  })

  it('preserves DST intervals and partial comparison rules in the employee scope', async () => {
    const owner = await actor()
    await db.query("update app_private.businesses set timezone='America/Chicago' where id=$1", [owner.businessId])
    for (const [date, asOf, hours] of [['2026-03-08', '2026-03-10T18:00:00Z', 23], ['2026-11-01', '2026-11-03T18:00:00Z', 25]] as const) {
      const report = (await db.query<{ report: BusinessPeriodReport }>('select app_private.ops_employee_period_report_at($1,$2,$3::date,\'day\',$4::timestamptz) report', [owner.businessId, owner.employeeId, date, asOf])).rows[0].report
      expect(report.series).toHaveLength(hours)
      expect(new Set(report.series.map(point => point.slot)).size).toBe(hours)
    }
    const partial = (await db.query<{ report: BusinessPeriodReport }>("select app_private.ops_employee_period_report_at($1,$2,'2026-03-08','day','2026-03-08T08:30:00Z') report", [owner.businessId, owner.employeeId])).rows[0].report
    expect(partial.comparisonComparable).toBe(false)
  })
})

async function actor(existingBusiness?: string, permissions: string[] = []): Promise<Actor> {
  const person = { userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  const role = existingBusiness ? 'cashier' : 'owner'
  await db.query('insert into auth.users(id) values($1)', [person.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [person.sessionId, person.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio de prueba','restaurant','America/Mexico_City','{"branchName":"Principal","registerName":"Caja","paymentMethods":["cash"]}')`, [person.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [person.businessId, person.userId, role])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Mismo nombre',$4,$5)", [person.employeeId, person.businessId, person.userId, role, permissions])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [person.businessId, person.userId, person.sessionId, person.token, person.keyHash])
  if (existingBusiness) await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador de prueba')", [person.businessId, person.employeeId, person.keyHash])
  return person
}
async function execute<T = unknown>(person: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [person.userId, person.sessionId, JSON.stringify({ action: 'pos', businessId: person.businessId, operatorToken: person.token, ...command }), person.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
async function item(person: Actor) { return execute<Product>(person, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto propio', category: 'Bebidas', priceCents: 11600, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 } }) }
async function pay(person: Actor, product: Product, quantity: number) {
  let order = await execute<OperationalOrder>(person, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Mostrador', tableId: null, items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity, note: '' }] })
  order = await execute(person, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
  let reservation = await execute<CheckoutAttempt>(person, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity }], paymentMethod: 'cash' })
  reservation = await execute(person, { command: 'start_checkout', operationId: randomUUID(), attemptId: reservation.id, expectedRevision: reservation.revision })
  return execute<CheckoutAttempt>(person, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: reservation.id, expectedRevision: reservation.revision, resolution: 'complete', confirmed: true, reason: 'Cobro registrado' })
}
