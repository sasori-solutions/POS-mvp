import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { BusinessPeriodReport, CheckoutAttempt, OperationalOrder, OperationsResponses } from '../../src/lib/operations-contracts'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import { checkoutAmountTotals } from '../../src/lib/checkout-amounts'
import { emptyDetails } from '../../src/lib/product-details'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
type Queryable = Pick<Transaction, 'query'>
type RecordPaymentResult = OperationsResponses['record_checkout']
let legacyActor: Actor, legacyPrepare: PosCommand, legacyQuote: CheckoutAttempt, legacyPayment: PosCommand, legacyReceipt: RecordPaymentResult

describe('amount checkout settlement', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create role authenticator noinherit; grant service_role to authenticator;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
      if (file === '20261005014000_amount_split_checkout.sql') {
        legacyActor = await fixture()
        const item = await product(legacyActor, 1001), pending = await createOrder(legacyActor, [{ product: item, quantity: 1 }])
        legacyPrepare = { command: 'prepare_checkout', operationId: randomUUID(), orderId: pending.id, expectedRevision: pending.revision, items: [{ lineId: pending.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' }
        legacyQuote = await execute(legacyActor, legacyPrepare)
        const completed = await createOrder(legacyActor, [{ product: item, quantity: 1 }])
        const quote = await execute<CheckoutAttempt>(legacyActor, { command: 'prepare_checkout', operationId: randomUUID(), orderId: completed.id, expectedRevision: completed.revision, items: [{ lineId: completed.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
        legacyPayment = { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
        legacyReceipt = await execute(legacyActor, legacyPayment)
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('preserves old pending reservations and accepted receipt payloads through the migration', async () => {
    expect(legacyQuote).not.toHaveProperty('amountsCents')
    expect(legacyReceipt.order).not.toHaveProperty('amountSplit')
    expect(await execute(legacyActor, legacyPrepare)).toEqual(legacyQuote)
    expect(await execute(legacyActor, legacyPayment)).toEqual(legacyReceipt)
    const settled = await execute<RecordPaymentResult>(legacyActor, { command: 'record_checkout', operationId: randomUUID(), attemptId: legacyQuote.id, expectedRevision: legacyQuote.revision, confirmed: true })
    expect(settled.order).toMatchObject({ orderKind: 'counter', amountSplit: false, balanceCents: 0 })
    expect(settled.attempt.items[0]).toMatchObject({ quantity: 1, totalCents: 1001 })
    expect(settled.attempt.items[0]).not.toHaveProperty('allocatedGrossCents')
  })

  it('collects 760.68 as 500, 40 and 220.68 with confirmed-only balance changes and exact replay', async () => {
    const actor=await fixture(), item=await product(actor,76068)
    let order=await createOrder(actor,[{product:item,quantity:1}])
    const original=order
    const quotes: CheckoutAttempt[]=[]
    const initialParts=[50000,4000,22068]
    for (let index=0;index<initialParts.length;index++) {
      const parts=initialParts.slice(index),before=order.balanceCents
      const preview=checkoutAmountTotals(order,parts[0])
      const prepare={command:'prepare_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:parts,paymentMethod: index===1?'transfer' as const:'cash' as const}
      const quote=await execute<CheckoutAttempt>(actor,prepare)
      expect(quote).toMatchObject({totalCents:preview.totalCents,discountCents:preview.discountCents,taxCents:preview.taxCents,amountsCents:parts,status:'prepared'})
      expect(await execute(actor,prepare)).toEqual(quote)
      expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({balanceCents:before})
      const payment={command:'record_checkout' as const,operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true as const}
      const paid=await execute<RecordPaymentResult>(actor,payment)
      expect(await execute(actor,payment)).toEqual(paid)
      order=paid.order;quotes.push(paid.attempt)
      expect(order.balanceCents).toBe(before-parts[0])
      expect(order.amountParts).toEqual(parts.slice(1))
      expect(order.amountPaidParts).toBe(index+1)
      if(index<2) expect(order).toMatchObject({status:'open',frozen:true})
    }
    expect(order).toMatchObject({status:'closed',paidCents:76068,balanceCents:0})
    expect(quotes.reduce((s,q)=>s+q.totalCents,0)).toBe(original.totalCents)
    expect(quotes.reduce((s,q)=>s+q.taxCents,0)).toBe(original.taxCents)
    expect(quotes.reduce((s,q)=>s+q.items.reduce((n,i)=>n+i.quantity,0),0)).toBe(1)
    expect(order.items[0].paidQuantity).toBe(1)
    const report=await execute<{grossCents:number;discountCents:number;salesCents:number;taxCents:number}>(actor,{command:'report',date:order.createdAt.slice(0,10)})
    expect(report).toMatchObject({grossCents:76068,discountCents:0,salesCents:76068,taxCents:original.taxCents})
    expect((await db.query<{result:Record<string,number>}>('select app_private.ops_financial_ledger_check() as result')).rows[0].result).toEqual(expect.objectContaining({invalidSales:0,invalidCompletedAttempts:0,invalidOrders:0}))
  })

  it.each([[0,76068],[-1,76069],[50000,4000,22067],[50000,4000,22069],[76068,1],[1.5,76066.5],[],[null,76068]])('rejects invalid parts %j without reservations or balance changes', async (...parts) => {
    const actor=await fixture(),item=await product(actor,76068),order=await createOrder(actor,[{product:item,quantity:1}])
    await expect(execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:parts,paymentMethod:'cash'} as PosCommand)).rejects.toThrow('VALIDATION_ERROR')
    expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({balanceCents:76068,paidCents:0,revision:order.revision})
    expect((await db.query<{n:number}>('select count(*)::int as n from app_private.checkout_attempts where business_id=$1',[actor.businessId])).rows[0].n).toBe(0)
  })

  it('updates and aborts a monetary reservation without collecting money; started/uncertain plans cannot change',async()=>{
    const actor=await fixture(),item=await product(actor,76068),order=await createOrder(actor,[{product:item,quantity:1}])
    let quote=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:[50000,26068],paymentMethod:'cash'})
    quote=await execute(actor,{command:'update_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,items:[],amountsCents:[50000,4000,22068],paymentMethod:'transfer'})
    expect(quote).toMatchObject({totalCents:50000,amountsCents:[50000,4000,22068],paymentMethod:'transfer'})
    quote=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision})
    quote=await execute(actor,{command:'mark_checkout_uncertain',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision})
    await expect(execute(actor,{command:'update_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,items:[],amountsCents:[1,76067],paymentMethod:'cash'})).rejects.toThrow('ATTEMPT_STATE_INVALID')
    expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({balanceCents:76068,paidCents:0})
    quote=await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,resolution:'abort',confirmed:true,reason:'Prueba de cancelación'})
    expect(quote.status).toBe('aborted')
    expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({balanceCents:76068,paidCents:0,amountSplit:false})
  })

  it('conserves cent discounts, tax, historical products and whole quantities with prior item collections',async()=>{
    const actor=await fixture(),products=await Promise.all([1001,201,1].map(v=>product(actor,v)))
    let order=await createOrder(actor,products.map(product=>({product,quantity:3})))
    order=await execute(actor,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'percent',value:3333,reason:'Centavos'}})
    const original=order
    const itemQuote=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    let paid=await execute<RecordPaymentResult>(actor,{command:'record_checkout',operationId:randomUUID(),attemptId:itemQuote.id,expectedRevision:itemQuote.revision,confirmed:true})
    order=paid.order
    const receipts=[paid.attempt]
    const parts=[1,101,order.balanceCents-102]
    for(let n=0;n<parts.length;n++) {
      const totals=checkoutAmountTotals(order,parts[n])
      const quote=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:parts.slice(n),paymentMethod:'cash'})
      expect(quote).toMatchObject({totalCents:totals.totalCents,discountCents:totals.discountCents,taxCents:totals.taxCents})
      paid=await execute<RecordPaymentResult>(actor,{command:'record_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true})
      receipts.push(paid.attempt);order=paid.order
    }
    expect(order).toMatchObject({status:'closed',balanceCents:0})
    expect(receipts.reduce((s,q)=>s+q.discountCents,0)).toBe(original.discountCents)
    expect(receipts.reduce((s,q)=>s+q.taxCents,0)).toBe(original.taxCents)
    expect(receipts.reduce((s,q)=>s+q.totalCents,0)).toBe(original.totalCents)
    expect(receipts.reduce((s,q)=>s+q.items.reduce((n,i)=>n+i.quantity,0),0)).toBe(9)
    let refund=await execute<CheckoutAttempt>(actor,{command:'prepare_reversal',operationId:randomUUID(),saleId:receipts[1].saleId!,reason:'Reembolso sintético'})
    refund=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision})
    refund=await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision,resolution:'complete',confirmed:true,reason:'Reembolso registrado'})
    expect(refund).toMatchObject({totalCents:1,status:'completed'})
  })

  it.each(['cancel','waive'] as const)('resolves only the unpaid monetary remainder with %s without changing recorded payments',async kind=>{
    const actor=await fixture(),item=await product(actor,76068)
    let order=await createOrder(actor,[{product:item,quantity:1}])
    const quote=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:[50000,26068],paymentMethod:'cash'})
    order=(await execute<RecordPaymentResult>(actor,{command:'record_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true})).order
    if(kind==='cancel') order=await execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cancelar resto sintético'})
    else {
      const waiver=await execute<{id:string;revision:number;amountCents:number}>(actor,{command:'prepare_waiver',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Condonar resto sintético'})
      expect(waiver.amountCents).toBe(26068)
      await execute(actor,{command:'confirm_waiver',operationId:randomUUID(),waiverId:waiver.id,expectedRevision:waiver.revision,confirmed:true})
      order=await execute(actor,{command:'order',orderId:order.id})
    }
    expect(order).toMatchObject({balanceCents:0,paidCents:50000})
    expect(order.cancelledCents+order.waivedCents).toBe(26068)
  })

  it('rolls back a monetary receipt and its balance if the accepted operation cannot persist',async()=>{
    const actor=await fixture(),item=await product(actor,76068),order=await createOrder(actor,[{product:item,quantity:1}])
    const quote=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:[50000,26068],paymentMethod:'cash'})
    const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true as const}
    await db.exec(`create function app_private.synthetic_fail_amount_response() returns trigger language plpgsql set search_path='' as $$ begin if new.operation_id='${command.operationId}'::uuid then raise exception 'SYNTHETIC_FAILURE'; end if; return new; end $$;
      create trigger synthetic_fail_amount_response before insert on app_private.pos_operations for each row execute function app_private.synthetic_fail_amount_response();`)
    try {
      await expect(execute(actor,command)).rejects.toThrow()
      expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({balanceCents:76068,paidCents:0})
      expect(await execute(actor,{command:'attempt',attemptId:quote.id})).toMatchObject({status:'prepared',saleId:null})
      expect((await db.query<{n:number}>('select count(*)::int n from app_private.sales where business_id=$1',[actor.businessId])).rows[0].n).toBe(0)
    } finally { await db.exec('drop trigger synthetic_fail_amount_response on app_private.pos_operations; drop function app_private.synthetic_fail_amount_response();') }
    expect((await execute<RecordPaymentResult>(actor,command)).order.balanceCents).toBe(26068)
  })

  it('rejects cross-tenant access, stale revisions, payload reuse and a closed cash shift',async()=>{
    const actor=await fixture(),other=await fixture(),item=await product(actor,1001),order=await createOrder(actor,[{product:item,quantity:1}])
    const request={command:'prepare_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:[501,500],paymentMethod:'cash' as const}
    const quote=await execute<CheckoutAttempt>(actor,request)
    await expect(execute(other,{command:'attempt',attemptId:quote.id})).rejects.toThrow('ATTEMPT_NOT_FOUND')
    await expect(execute(actor,{...request,amountsCents:[500,501]})).rejects.toThrow('OPERATION_CONFLICT')
    await expect(execute(actor,{command:'update_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision+1,items:[],amountsCents:[500,501],paymentMethod:'cash'})).rejects.toThrow('ATTEMPT_CHANGED')
    await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,resolution:'abort',confirmed:true,reason:'Cancelar reserva'})
    const shift=(await execute<{shifts:{id:string;revision:number}[]}>(actor,{command:'shifts'})).shifts[0]
    const closing=await execute<{id:string;revision:number}>(actor,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    await execute(actor,{command:'close_shift',operationId:randomUUID(),shiftId:closing.id,expectedRevision:closing.revision,countedCents:0})
    const current=await execute<OperationalOrder>(actor,{command:'order',orderId:order.id})
    await expect(execute(actor,{...request,operationId:randomUUID(),expectedRevision:current.revision})).rejects.toThrow('SHIFT_REQUIRED')
  })

  it('keeps employee gross, discounts, IVA and zero-unit refunds exact without another employee receipts', async () => {
    const owner = await fixture(), employee = await staff(owner), item = await product(owner, 11600)
    let order = await createOrder(employee, [{ product: item, quantity: 1 }])
    order = await execute(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'fixed', value: 1160, reason: 'Descuento sintético' } })
    const quote = await execute<CheckoutAttempt>(employee, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [], amountsCents: [5220, 5220], paymentMethod: 'cash' })
    const paid = await execute<RecordPaymentResult>(employee, { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
    expect(paid.order).toMatchObject({ orderKind: 'counter', balanceCents: 5220, paidCents: 5220 })
    expect(paid.attempt.items[0]).toMatchObject({ quantity: 0, totalCents: 5220, discountCents: 580, taxCents: 720, allocatedGrossCents: 5800 })
    const otherOrder = await createOrder(owner, [{ product: item, quantity: 1 }])
    const otherQuote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: otherOrder.id, expectedRevision: otherOrder.revision, items: [{ lineId: otherOrder.items[0].lineId, quantity: 1 }], paymentMethod: 'cash' })
    await execute(owner, { command: 'record_checkout', operationId: randomUUID(), attemptId: otherQuote.id, expectedRevision: otherQuote.revision, confirmed: true })
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    let own = await execute<BusinessPeriodReport>(employee, { command: 'report_own_period', date, period: 'day' })
    expect(own.totals).toMatchObject({ grossCents: 5800, discountCents: 580, salesCents: 5220, taxCents: 720, saleCount: 1, operators: [], cashDifferences: [] })
    expect(own.totals.products).toHaveLength(1)
    expect(own.totals.products[0]).toMatchObject({ quantity: 0, salesCents: 5220, taxCents: 720, netCents: 5220 })
    expect(own.totals.grossCents - own.totals.discountCents).toBe(own.totals.salesCents)
    const reversal = await execute<CheckoutAttempt>(owner, { command: 'prepare_reversal', operationId: randomUUID(), saleId: paid.attempt.saleId!, reason: 'Devolver parte sintética' })
    const started = await execute<CheckoutAttempt>(owner, { command: 'start_checkout', operationId: randomUUID(), attemptId: reversal.id, expectedRevision: reversal.revision })
    await execute(owner, { command: 'resolve_checkout', operationId: randomUUID(), attemptId: started.id, expectedRevision: started.revision, resolution: 'complete', confirmed: true, reason: 'Devolución sintética' })
    own = await execute(employee, { command: 'report_own_period', date, period: 'day' })
    expect(own.totals).toMatchObject({ grossCents: 5800, discountCents: 580, salesCents: 5220, reversalCents: 5220, reversalTaxCents: 720, netCents: 0 })
    expect(own.totals.products[0]).toMatchObject({ quantity: 0, reversalQuantity: 0, netCents: 0, netTaxCents: 0 })
    expect(own.series.reduce((sum, point) => sum + point.netCents, 0)).toBe(0)
  })

  it('keeps monetary helpers and persisted financial tables inaccessible to browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['app_private.ops_amount_parts_valid(jsonb)', 'app_private.ops_amount_quote(uuid,uuid,bigint)', 'app_private.ops_amount_plan(uuid,uuid,jsonb)', 'app_private.ops_validate(jsonb)', 'app_private.ops_validate_before_amount(jsonb)'])
        expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
      for (const table of ['checkout_attempts', 'sales', 'sale_items'])
        expect((await db.query<{ allowed: boolean }>('select has_table_privilege($1,$2,\'UPDATE\') allowed', [role, `app_private.${table}`])).rows[0].allowed).toBe(false)
    }
  })
})

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
  assertFinancialResponse(command,result.data)
  return result.data
}
async function product(actor: Actor, priceCents: number) {
  return execute<Product>(actor, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents, details: { ...emptyDetails(), taxBps: 1600, taxTreatment: 'vat_16' } })
}
async function createOrder(actor: Actor, items: { product: Product; quantity: number }[]) {
  return execute<OperationalOrder>(actor, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta sintética', tableId: null, orderKind: 'counter', items: items.map(({ product: item, quantity }) => ({ lineId: randomUUID(), productId: item.id, quantity, unitPriceCents: item.priceCents, version: item.version, note: '' })) })
}

async function staff(owner: Actor): Promise<Actor> {
  const actor = { ...owner, userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'cashier')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Operador sintético','cashier',$4)", [actor.employeeId, actor.businessId, actor.userId, ['catalog.read', 'sales.create', 'reports.read_own']])
  await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [actor.businessId, actor.employeeId, actor.keyHash])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [actor.businessId, actor.userId, actor.sessionId, actor.token, actor.keyHash])
  return actor
}
