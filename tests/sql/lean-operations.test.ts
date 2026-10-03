import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { CashShift, OperationalOrder, CheckoutAttempt, BalanceWaiver, BusinessDayReport, BusinessPeriodReport, KitchenBatch, DiningTable, OperationsSnapshot } from '../../src/lib/operations-contracts'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import { emptyDetails } from '../../src/lib/product-details'

let db: PGlite
let historical: { actor: Actor; order: OperationalOrder; batchId: string; legacyActor: Actor; legacyCommand: PosCommand; legacyResult: unknown }
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }

describe('Lean POS private transactions with real PostgreSQL migrations', () => {
  beforeAll(async () => {
    db=new PGlite({extensions:{pgcrypto}})
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
      if (file.startsWith('20261002002800')) {
        const owner=await newActor();await activate(owner);await open(owner)
        const actor=await newActor(owner.businessId,['orders.read','orders.manage','orders.cancel','kitchen.read','kitchen.operate'])
        const product=await newProduct(owner);let order=await newOrder(actor,product)
        order=await execute(actor,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
        const batch=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches[0]
        await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'preparing'})
        const legacyOrder=await newOrder(owner,product)
        const legacyCommand:PosCommand={command:'record_payment',operationId:randomUUID(),orderId:legacyOrder.id,expectedRevision:legacyOrder.revision,items:[{lineId:legacyOrder.items[0].lineId,quantity:1}],paymentMethod:'cash',confirmed:true}
        historical={actor,order,batchId:batch.id,legacyActor:owner,legacyCommand,legacyResult:await execute(owner,legacyCommand)}
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
    }
  },60_000)
  afterAll(async()=>{await db?.close()})

  it('keeps legacy preparation protected after two-state normalization and preserves accepted old payments',async()=>{
    const {actor,order,batchId,legacyActor,legacyCommand,legacyResult}=historical
    expect((await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches.find(b=>b.id===batchId)?.status).toBe('preparing')
    await expect(execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'No borrar preparación'})).rejects.toThrow('ORDER_LOCKED')
    await db.query("update app_private.kitchen_batches set status='queued' where id=$1",[batchId])
    await expect(execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Historial protegido'})).rejects.toThrow('ORDER_LOCKED')
    expect(await execute(legacyActor,legacyCommand)).toEqual(legacyResult)
    await expect(execute(legacyActor,{...legacyCommand,operationId:randomUUID()} as PosCommand)).rejects.toThrow('ATTEMPT_STATE_INVALID')
  })

  it('reserves and updates a quote without a closing gap, validates money and enforces current grants on retry',async()=>{
    const owner=await newActor();await activate(owner);const shift=await open(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create'])
    const product=await newProduct(owner),order=await newOrder(cashier,product,3)
    const reservation=await reserve(cashier,order,3)
    await expect(execute(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})).rejects.toThrow('PENDING_COLLECTION')
    const change={command:'update_checkout' as const,operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'transfer' as const}
    const quote=await execute<CheckoutAttempt>(cashier,change)
    expect(quote).toMatchObject({id:reservation.id,totalCents:1001,paymentMethod:'transfer',status:'prepared'})
    expect(await execute(cashier,change)).toEqual(quote)
    await expect(execute(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})).rejects.toThrow('PENDING_COLLECTION')
    await expect(execute(cashier,{...change,operationId:randomUUID(),items:[{lineId:order.items[0].lineId,quantity:4}]})).rejects.toThrow('ATTEMPT_CHANGED')
    await expect(execute(cashier,{...change,operationId:randomUUID(),expectedRevision:quote.revision,items:[{lineId:order.items[0].lineId,quantity:4}]})).rejects.toThrow('ORDER_CHANGED')
    await db.query('update app_private.employees set permissions=$1 where id=$2',[['catalog.read'],cashier.employeeId])
    await expect(execute(cashier,change)).rejects.toThrow('SESSION_INVALID')
    await expect(execute(cashier,{command:'record_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true})).rejects.toThrow('SESSION_INVALID')
    await expect(execute(await newActor(),{command:'attempt',attemptId:quote.id})).rejects.toThrow('ATTEMPT_NOT_FOUND')
  })

  it('lets an availability-only employee change a product and size without changing catalog metadata',async()=>{
    const owner=await newActor(),actor=await newActor(owner.businessId,['catalog.read','catalog.availability'])
    const variationId=randomUUID(), otherId=randomUUID()
    const product=await execute<Product>(owner,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Tamaños sintéticos',category:'Café',priceCents:1001,details:{...emptyDetails(),variations:[{id:variationId,name:'Chico',priceCents:1001,sku:'CH',barcode:'',soldOut:false},{id:otherId,name:'Grande',priceCents:2001,sku:'GR',barcode:'',soldOut:false}]}})
    const command={command:'set_product_sold_out' as const,operationId:randomUUID(),productId:product.id,expectedVersion:product.version,variationId,soldOut:true}
    const saved=await execute<Product>(actor,command)
    expect(saved.details).toEqual({...product.details,variations:product.details!.variations.map(v=>v.id===variationId?{...v,soldOut:true}:v)})
    expect(await execute(actor,command)).toEqual(saved)
    const available=await execute<Product>(actor,{...command,operationId:randomUUID(),expectedVersion:saved.version,soldOut:false})
    expect(available.details!.variations.every(v=>!v.soldOut)).toBe(true)
    await expect(execute(actor,{command:'save_product',operationId:randomUUID(),productId:product.id,expectedVersion:available.version,name:'No permitido',category:'',priceCents:1})).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(actor,{...command,operationId:randomUUID(),expectedVersion:available.version,variationId:randomUUID()})).rejects.toThrow('VALIDATION_ERROR')
    const unavailable=await execute<Product>(actor,{command:'set_product_sold_out',operationId:randomUUID(),productId:product.id,expectedVersion:available.version,soldOut:true})
    expect(unavailable.details!.soldOut).toBe(true)
    expect(unavailable.details!.variations).toEqual(available.details!.variations)
  })

  it('matches the selected discount and IVA preview to server quotes across successive item payments',async()=>{
    const actor=await newActor();await activate(actor);await open(actor)
    const product=await newProduct(actor,1);let order=await newOrder(actor,product,7)
    order=await execute(actor,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:3,reason:'Centavos'}})
    let collected=0,discount=0,tax=0
    for(let n=0;n<7;n++) {
      const items=[{lineId:order.items[0].lineId,quantity:1}],totals=checkoutTotals(order,items)
      const quote=await reserve(actor,order,1)
      expect(quote).toMatchObject({totalCents:totals.totalCents,discountCents:totals.discountCents,taxCents:totals.taxCents})
      const paid=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(actor,{command:'record_checkout',operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true})
      collected+=paid.attempt.totalCents;discount+=paid.attempt.discountCents;tax+=paid.attempt.taxCents;order=paid.order
    }
    expect([collected,discount,tax]).toEqual([4,3,1]);expect(order.status).toBe('closed')
  })

  it('authorizes period reports without enabling operations, denies ungranted employees and keeps tenant isolation', async()=>{
    const owner=await newActor(), reader=await newActor(owner.businessId,['reports.read']), cashier=await newActor(owner.businessId,['catalog.read','sales.create'])
    const command={command:'report_period' as const,date:'2026-01-15',period:'month' as const}
    const report=await execute<BusinessPeriodReport>(reader,command)
    expect(report).toMatchObject({startDate:'2026-01-01',endDate:'2026-01-31',totals:{salesCents:0,saleCount:0},series:expect.any(Array)})
    expect(report.series).toHaveLength(31)
    await expect(execute(cashier,command)).rejects.toThrow('PERMISSION_DENIED')
    const other=await newActor();await activate(other);await open(other)
    const product=await newProduct(other);await pay(other,await newOrder(other,product),'cash')
    expect((await execute<BusinessPeriodReport>(owner,command)).totals.salesCents).toBe(0)
    await db.query('update app_private.employees set permissions=$1 where id=$2',[[],reader.employeeId])
    await expect(execute(reader,command)).rejects.toThrow()
  })

  it('period financial totals match the accepted daily report and chart sums exactly', async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const product=await newProduct(owner);await pay(owner,await newOrder(owner,product,3),'cash')
    const day=(await db.query<{day:string}>("select to_char(clock_timestamp() at time zone 'America/Mexico_City','YYYY-MM-DD') as \"day\"")).rows[0].day
    const daily=await execute<BusinessDayReport>(owner,{command:'report',date:day})
    const report=await execute<BusinessPeriodReport>(owner,{command:'report_period',date:day,period:'day'})
    expect(report.totals).toEqual(daily)
    expect(report.totals).toMatchObject({salesCents:3003,saleCount:1})
    expect(report.series.reduce((sum,p)=>sum+p.salesCents,0)).toBe(3003)
    expect(report.partial).toBe(true)
    expect(report.previous.salesCents).toBe(0)
  })

  it('uses local calendar boundaries for short/long DST days and leap months', async()=>{
    const owner=await newActor();await db.query("update app_private.businesses set timezone='America/Chicago' where id=$1",[owner.businessId])
    expect((await execute<BusinessPeriodReport>(owner,{command:'report_period',date:'2026-03-08',period:'day'})).series).toHaveLength(23)
    const fall=await execute<BusinessPeriodReport>(owner,{command:'report_period',date:'2026-11-01',period:'day'})
    expect(fall.series).toHaveLength(25);expect(new Set(fall.series.map(p=>p.start)).size).toBe(25)
    const leap=await execute<BusinessPeriodReport>(owner,{command:'report_period',date:'2024-02-15',period:'month'})
    expect(leap.series).toHaveLength(29);expect(leap).toMatchObject({startDate:'2024-02-01',endDate:'2024-02-29',comparisonStartDate:'2024-01-01',comparisonEndDate:'2024-01-31',partial:false})
    expect(await execute(owner,{command:'report_period',date:'2026-01-01',period:'week'})).toMatchObject({startDate:'2025-12-29',endDate:'2026-01-04'})
    await expect(execute(owner,{command:'report_period',date:'2026-02-30',period:'day'})).rejects.toThrow('VALIDATION_ERROR')
    await expect(execute(owner,{command:'report_period',date:'2026-01-01',period:'year'} as unknown as PosCommand)).rejects.toThrow('VALIDATION_ERROR')
  })

  it('keeps chart snapshot sums exact across refunds, discounts and the exclusive asOf cutoff',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const product=await newProduct(owner)
    const prior=await pay(owner,await newOrder(owner,product),'cash')
    let order=await newOrder(owner,product,2)
    order=await execute(owner,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:3,reason:'Descuento sintético'}})
    const current=await pay(owner,order,'transfer'),boundary=await pay(owner,await newOrder(owner,product),'card_external')
    for(const [id,time] of [[prior.saleId,'2026-10-02T18:10:00Z'],[current.saleId,'2026-10-03T18:10:00Z'],[boundary.saleId,'2026-10-03T18:30:00Z']]) await db.query('update app_private.sales set created_at=$1 where id=$2',[time,id])
    let refund=await execute<CheckoutAttempt>(owner,{command:'prepare_reversal',operationId:randomUUID(),saleId:prior.saleId!,reason:'Venta anterior'})
    refund=await execute(owner,{command:'start_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision})
    await execute(owner,{command:'resolve_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision,resolution:'complete',confirmed:true,reason:'Dinero devuelto'})
    await db.query("update app_private.sale_reversals set created_at='2026-10-03T18:15:00Z' where sale_id=$1",[prior.saleId])
    const report=await reportAt(owner,'2026-10-03','day','2026-10-03T18:30:00Z')
    expect(report).toMatchObject({partial:true,comparisonComparable:true,totals:{grossCents:2002,discountCents:3,salesCents:1999,reversalCents:1001,netCents:998,saleCount:1},previous:{salesCents:1001,saleCount:1}})
    expect(new Date(report.cutoff).toISOString()).toBe('2026-10-03T18:30:00.000Z')
    expect(new Date(report.previousCutoff).toISOString()).toBe('2026-10-02T18:30:00.000Z')
    for(const [series,totals] of [[report.series,report.totals],[report.previousSeries,report.previous]] as const) {
      for(const field of ['salesCents','reversalCents','netCents','saleCount'] as const) expect(series.reduce((sum,p)=>sum+p[field],0)).toBe(totals[field])
      expect(totals.grossCents-totals.discountCents).toBe(totals.salesCents)
      expect(totals.salesCents-totals.reversalCents).toBe(totals.netCents)
    }
    expect(report.series.find(p=>p.slot==='hour:12:00:0')).toMatchObject({salesCents:1999,reversalCents:1001,netCents:998,saleCount:1,future:false})
    expect(report.series.filter(p=>p.future).every(p=>p.salesCents===0 && p.reversalCents===0 && p.netCents===0 && p.saleCount===0)).toBe(true)
  })

  it('distinguishes real empty and zero-value buckets from calendar slots that do not exist',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const product=await newProduct(owner,0),sale=await pay(owner,await newOrder(owner,product),'cash')
    await db.query("update app_private.sales set created_at='2026-02-28T17:00:00Z' where id=$1",[sale.saleId])
    const report=await reportAt(owner,'2026-02-28','month','2026-03-01T06:00:00Z')
    expect(report.series).toHaveLength(28);expect(report.previousSeries).toHaveLength(31)
    expect(report.comparisonComparable).toBe(true)
    expect(report.series.find(p=>p.slot==='day:28')).toMatchObject({salesCents:0,saleCount:1,future:false})
    expect(report.series.find(p=>p.slot==='day:27')).toMatchObject({salesCents:0,saleCount:0,future:false})
    expect(report.series.find(p=>p.slot==='day:29')).toBeUndefined()
    const negative=await reportAt(owner,'2026-04-01','day','2026-04-01T06:00:00Z')
    expect(negative.series).toHaveLength(24);expect(negative.series.every(p=>p.future)).toBe(true)
  })

  it('keeps 23 and 25 real hourly buckets and omits inequivalent partial DST comparisons',async()=>{
    const owner=await newActor();await db.query("update app_private.businesses set timezone='America/Chicago' where id=$1",[owner.businessId])
    const spring=await reportAt(owner,'2026-03-08','day','2026-03-10T12:00:00Z')
    expect(spring.series).toHaveLength(23);expect(spring.previousSeries).toHaveLength(24)
    expect(spring.series.some(p=>p.slot==='hour:02:00:0')).toBe(false)
    const fall=await reportAt(owner,'2026-11-01','day','2026-11-03T12:00:00Z')
    expect(fall.series).toHaveLength(25)
    expect(fall.series.filter(p=>p.label==='01:00').map(p=>p.slot)).toEqual(['hour:01:00:0','hour:01:00:1'])
    expect(new Set(fall.series.map(p=>p.start)).size).toBe(25)
    expect(fall.comparisonComparable).toBe(true)
    expect(fall.series.every(p=>new Date(p.end).getTime()>new Date(p.start).getTime())).toBe(true)
    for(const [date,asOf] of [['2026-03-08','2026-03-08T08:30:00Z'],['2026-03-09','2026-03-09T07:30:00Z'],['2026-11-01','2026-11-01T06:30:00Z'],['2026-11-02','2026-11-02T07:30:00Z']]) {
      expect((await reportAt(owner,date,'day',asOf)).comparisonComparable).toBe(false)
    }
    const unique=(await db.query<{matches:number}>("select matches::integer from app_private.ops_local_cutoff(timestamp '2026-03-08 02:30','America/Chicago')")).rows[0].matches
    const repeated=(await db.query<{matches:number}>("select matches::integer from app_private.ops_local_cutoff(timestamp '2026-11-01 01:30','America/Chicago')")).rows[0].matches
    expect([unique,repeated]).toEqual([0,2])
  })

  it('caps previous partial months, excludes future windows and keeps one cutoff for every metric',async()=>{
    const owner=await newActor()
    const partial=await reportAt(owner,'2026-03-15','month','2026-03-15T18:30:00Z')
    expect(partial).toMatchObject({partial:true,comparisonComparable:true,startDate:'2026-03-01',comparisonStartDate:'2026-02-01'})
    expect(new Date(partial.previousCutoff).toISOString()).toBe('2026-02-15T18:30:00.000Z')
    expect(partial.series.find(p=>p.slot==='day:15')?.future).toBe(false)
    expect(partial.previousSeries.find(p=>p.slot==='day:16')?.future).toBe(true)
    const tooLong=await reportAt(owner,'2026-03-30','month','2026-03-30T18:30:00Z')
    expect(tooLong.comparisonComparable).toBe(false)
    expect(new Date(tooLong.previousCutoff).toISOString()).toBe('2026-03-01T06:00:00.000Z')
    const future=await reportAt(owner,'2026-04-03','day','2026-04-02T18:00:00Z')
    expect(future).toMatchObject({partial:false,comparisonComparable:false,totals:{salesCents:0,reversalCents:0,saleCount:0},previous:{salesCents:0,reversalCents:0,saleCount:0}})
    expect(future.series.every(p=>p.future)).toBe(true);expect(future.previousSeries.every(p=>p.future)).toBe(true)
    expect(new Date(future.cutoff).toISOString()).toBe('2026-04-03T06:00:00.000Z')
    expect(new Date(future.previousCutoff).toISOString()).toBe('2026-04-02T06:00:00.000Z')
  })

  it('preserves registered IVA without inventing a tax rate or repairing legacy snapshots',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const product=await newProduct(owner,11600)
    const known=await pay(owner,await newOrder(owner,product),'cash'),unknown=await pay(owner,await newOrder(owner,product),'cash')
    await db.query('update app_private.sale_items set tax_treatment=null,tax_bps=null where sale_id=$1',[known.saleId])
    await db.query('update app_private.sale_items set tax_treatment=null,tax_bps=null,tax_cents=0 where sale_id=$1',[unknown.saleId])
    await db.query("update app_private.sales set created_at='2026-10-02T18:00:00Z' where id=any($1::uuid[])",[[known.saleId,unknown.saleId]])
    const report=await reportAt(owner,'2026-10-02','day','2026-10-03T18:30:00Z')
    expect(report.totals).toMatchObject({salesCents:23200,taxCents:1600,grossCents:23200,discountCents:0})
    expect((await db.query<{tax_bps:null;tax_treatment:null}>('select tax_bps,tax_treatment from app_private.sale_items where sale_id=$1',[known.saleId])).rows[0]).toEqual({tax_bps:null,tax_treatment:null})
  })

  it('keeps every analytics helper private with an empty search path',async()=>{
    const signatures=['app_private.ops_report_series(uuid,date,date,text,text,timestamptz)','app_private.ops_local_cutoff(timestamp,text)','app_private.ops_period_report_at(uuid,date,text,timestamptz)','app_private.ops_period_report(uuid,date,text)']
    for(const signature of signatures) {
      const privileges=(await db.query<{anon:boolean;authenticated:boolean;service:boolean;settings:string[]}>('select has_function_privilege(\'anon\',$1,\'execute\') anon,has_function_privilege(\'authenticated\',$1,\'execute\') authenticated,has_function_privilege(\'service_role\',$1,\'execute\') service,proconfig settings from pg_proc where oid=$1::regprocedure',[signature])).rows[0]
      expect(privileges).toEqual({anon:false,authenticated:false,service:true,settings:['search_path=""']})
    }
  })

  it('permits refund-only staff to recover reversals without exposing cash amounts or other payment attempts',async()=>{
    const owner=await newActor();await activate(owner);await open(owner,50000)
    const staff=await newActor(owner.businessId,['sales.read_all','sales.reverse'])
    const product=await newProduct(owner), paid=await pay(owner,await newOrder(owner,product),'cash')
    const reversal=await execute<CheckoutAttempt>(staff,{command:'prepare_reversal',operationId:randomUUID(),saleId:paid.saleId!,reason:'Corrección sintética'})
    let unpaid=await newOrder(owner,product)
    unpaid=await execute(owner,{command:'begin_order_checkout',operationId:randomUUID(),orderId:unpaid.id,expectedRevision:unpaid.revision})
    await execute(owner,{command:'prepare_checkout',operationId:randomUUID(),orderId:unpaid.id,expectedRevision:unpaid.revision,items:[{lineId:unpaid.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    const view=await execute<OperationsSnapshot>(staff,{command:'operations'})
    expect(view.shift).toMatchObject({status:'open',openingCents:0,expectedCents:null,countedCents:null,movements:[]})
    expect(view.orders).toEqual([])
    expect(view.attempts).toEqual([reversal])
  })

  it('aggregates full calendar weeks and reports a historical sale refund on its effective date',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const product=await newProduct(owner)
    const prior=await pay(owner,await newOrder(owner,product),'card_external')
    const start=await pay(owner,await newOrder(owner,product,2),'cash')
    const end=await pay(owner,await newOrder(owner,product,3),'transfer')
    for(const [id,date] of [[prior.saleId,'2025-01-05'],[start.saleId,'2025-01-06'],[end.saleId,'2025-01-12']]) await db.query("update app_private.sales set created_at=$1::date::timestamp at time zone 'America/Mexico_City' + interval '12 hours' where id=$2",[date,id])
    const week=await execute<BusinessPeriodReport>(owner,{command:'report_period',date:'2025-01-08',period:'week'})
    expect(week.totals).toMatchObject({salesCents:5005,saleCount:2})
    expect(week.previous.salesCents).toBe(1001)
    expect(week.series.map(p=>p.salesCents)).toEqual([2002,0,0,0,0,0,3003])
    expect(week.comparisonComparable).toBe(true)
    let refund=await execute<CheckoutAttempt>(owner,{command:'prepare_reversal',operationId:randomUUID(),saleId:prior.saleId!,reason:'Reembolso sintético'})
    refund=await execute(owner,{command:'start_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision})
    await execute(owner,{command:'resolve_checkout',operationId:randomUUID(),attemptId:refund.id,expectedRevision:refund.revision,resolution:'complete',confirmed:true,reason:'Devuelto externamente'})
    const day=(await db.query<{day:string}>("select to_char(clock_timestamp() at time zone 'America/Mexico_City','YYYY-MM-DD') as \"day\"")).rows[0].day
    // Give the fixture an explicit effective time before the exclusive as-of boundary.
    await db.query("update app_private.sale_reversals set created_at=clock_timestamp()-interval '1 second' where business_id=$1",[owner.businessId])
    const today=await execute<BusinessPeriodReport>(owner,{command:'report_period',date:day,period:'day'})
    expect(today.totals).toMatchObject({salesCents:0,saleCount:0,reversalCents:1001,netCents:-1001})
    expect(today.series.reduce((sum,p)=>sum+p.reversalCents,0)).toBe(1001)
    expect(today.series.reduce((sum,p)=>sum+p.netCents,0)).toBe(-1001)
  })

  it('records payment and comanda with one command, closes the paid order and safely replays after closing the shift',async()=>{
    const owner=await newActor();await activate(owner);const shift=await open(owner,500)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner), order=await newOrder(cashier,product,2)
    const reservation=await reserve(cashier,order,2)
    const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,confirmed:true as const}
    const result=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(cashier,command)
    expect(result.order).toMatchObject({status:'closed',balanceCents:0,paidCents:2002,items:[{paidQuantity:2,sentQuantity:2}]})
    expect(result.attempt).toMatchObject({status:'completed',totalCents:2002,paymentMethod:'cash'})
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toMatchObject([{items:[{name:'Café cocina',quantity:2}]}])
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toHaveLength(1)
    expect((await execute<{attempts:CheckoutAttempt[]}>(cashier,{command:'operations'})).attempts).toHaveLength(0)
    const closing=await execute<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    expect(await execute(owner,{command:'close_shift',operationId:randomUUID(),shiftId:shift.id,expectedRevision:closing.revision,countedCents:2502})).toMatchObject({expectedCents:2502,differenceCents:0})
    expect(await execute(cashier,command)).toEqual(result)
    await expect(execute(cashier,{...command,expectedRevision:command.expectedRevision+1})).rejects.toThrow('OPERATION_CONFLICT')
    expect((await db.query<{count:number}>('select count(*)::integer count from app_private.sales where business_id=$1',[owner.businessId])).rows[0].count).toBe(1)
    await db.query('update app_private.employees set permissions=$1 where id=$2',[['catalog.read'],cashier.employeeId])
    await expect(execute(cashier,command)).rejects.toThrow()
  })

  it('rolls back the whole one-step payment if comanda creation fails, then retries the original UUID',async()=>{
    const actor=await newActor();await activate(actor);await open(actor)
    const product=await newProduct(actor),order=await newOrder(actor,product)
    const reservation=await reserve(actor,order,1)
    const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,confirmed:true as const}
    await db.exec("create function app_private.reject_test_batch() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Test comanda failure'; end $$; create trigger reject_test_batch before insert on app_private.kitchen_batches for each row execute function app_private.reject_test_batch();")
    try {
      await expect(execute(actor,command)).rejects.toThrow()
      expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({paidCents:0,phase:'checkout'})
      expect(await execute(actor,{command:'attempt',attemptId:reservation.id})).toEqual(reservation)
      for(const table of ['sales','kitchen_batches']) expect((await db.query<{count:number}>(`select count(*)::integer count from app_private.${table} where business_id=$1`,[actor.businessId])).rows[0].count).toBe(0)
      expect((await db.query<{count:number}>('select count(*)::integer count from app_private.pos_operations where business_id=$1 and operation_id=$2',[actor.businessId,command.operationId])).rows[0].count).toBe(0)
    } finally {await db.exec('drop trigger reject_test_batch on app_private.kitchen_batches; drop function app_private.reject_test_batch();')}
    const result=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(actor,command)
    expect(result.attempt.status).toBe('completed')
    expect(await execute(actor,command)).toEqual(result)
    await expect(execute(actor,{...command,operationId:randomUUID()})).rejects.toThrow('ATTEMPT_CHANGED')
  })

  it('keeps partial item payments exact and sends only paid items, rejecting collection during counting',async()=>{
    const actor=await newActor();await activate(actor);const shift=await open(actor)
    const product=await newProduct(actor),original=await newOrder(actor,product,3)
    const reservation=await reserve(actor,original,1)
    const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,confirmed:true as const}
    const first=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(actor,command)
    expect(first.order).toMatchObject({status:'open',balanceCents:2002,paidCents:1001,items:[{paidQuantity:1,sentQuantity:1}]})
    const closing=await execute<CashShift>(actor,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    await expect(reserve(actor,first.order,2)).rejects.toThrow('SHIFT_NOT_OPEN')
    await execute(actor,{command:'abort_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:closing.revision})
    const nextReservation=await reserve(actor,first.order,2)
    const last=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(actor,{command:'record_checkout',operationId:randomUUID(),attemptId:nextReservation.id,expectedRevision:nextReservation.revision,confirmed:true})
    expect(last.order).toMatchObject({status:'closed',balanceCents:0,paidCents:3003,items:[{paidQuantity:3,sentQuantity:3}]})
    const batches=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches
    expect(batches.map(batch=>batch.items[0].quantity).sort()).toEqual([1,2])
  })

  it('replays a cashier payment using accepted scope after an older client moves the unpaid remainder',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner),order=await newOrder(cashier,product,2)
    const reservation=await reserve(cashier,order,1)
    const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,confirmed:true as const}
    const result=await execute<{order:OperationalOrder;attempt:CheckoutAttempt}>(cashier,command)
    const table=await execute<DiningTable>(owner,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa histórica',active:true})
    await execute(owner,{command:'move_order',operationId:randomUUID(),orderId:order.id,expectedRevision:result.order.revision,tableId:table.id})
    expect(await execute(cashier,command)).toEqual(result)
    await expect(execute(cashier,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:result.order.revision+1,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})).rejects.toThrow('PERMISSION_DENIED')
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toHaveLength(1)
  })

  it('prepares directly from service and sends only newly paid quantities once, using accepted kitchen snapshots',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner)
    let order=await newOrder(cashier,product,3)
    const lineId=order.items[0].lineId
    const prepare={command:'prepare_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId,quantity:1}],paymentMethod:'cash' as const}
    let attempt=await execute<CheckoutAttempt>(cashier,prepare)
    expect(await execute(cashier,prepare)).toEqual(attempt)
    expect(await execute(owner,{command:'order',orderId:order.id})).toMatchObject({phase:'checkout',frozen:false})
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toHaveLength(0)
    await expect(execute(cashier,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Antes de iniciar'})).rejects.toThrow('ATTEMPT_STATE_INVALID')
    attempt=await execute(cashier,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toHaveLength(0)
    // Current catalog changes do not alter accepted kitchen or financial snapshots.
    await db.query("update app_private.products set name='Nombre posterior' where business_id=$1 and id=$2",[owner.businessId,product.id])
    const complete={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete' as const,confirmed:true as const,reason:'Pago recibido'}
    const paid=await execute<CheckoutAttempt>(cashier,complete)
    expect(await execute(cashier,complete)).toEqual(paid)
    expect(await execute(cashier,{...complete,operationId:randomUUID(),expectedRevision:paid.revision}).catch((e:Error)=>e.message)).toBe('ATTEMPT_STATE_INVALID')
    let batches=(await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches
    expect(batches).toHaveLength(1)
    expect(batches[0].items).toMatchObject([{lineId,name:'Café cocina',quantity:1}])
    order=await execute(owner,{command:'order',orderId:order.id})
    expect(order.items[0]).toMatchObject({paidQuantity:1,sentQuantity:1,quantity:3})
    await pay(cashier,order,'cash')
    batches=(await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches
    expect(batches).toHaveLength(2)
    expect(batches.reduce((sum,batch)=>sum+batch.items[0].quantity,0)).toBe(3)
    expect(await execute(owner,{command:'order',orderId:order.id})).toMatchObject({status:'paid',items:[{paidQuantity:3,sentQuantity:3}]})
    await db.query('update app_private.employees set permissions=$1 where id=$2',[['catalog.read','sales.read_own'],cashier.employeeId])
    await expect(execute(cashier,complete)).rejects.toThrow()
    expect((await execute<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches).toHaveLength(2)
  })

  it('aborting an unpaid prepared checkout restores service and permits editing without sending to kitchen',async()=>{
    const actor=await newActor();await activate(actor);await open(actor)
    const product=await newProduct(actor)
    let order=await newOrder(actor,product)
    const attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    const abort={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'abort' as const,confirmed:true as const,reason:'Volver antes de cobrar'}
    expect(await execute(actor,abort)).toMatchObject({status:'aborted'})
    expect(await execute(actor,abort)).toMatchObject({status:'aborted'})
    order=await execute(actor,{command:'order',orderId:order.id})
    expect(order).toMatchObject({phase:'service',frozen:false,items:[{paidQuantity:0,sentQuantity:0}]})
    const edited=await execute(actor,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[{lineId:order.items[0].lineId,productId:product.id,version:product.version,unitPriceCents:product.priceCents,quantity:2,note:''}]})
    expect(edited).toMatchObject({phase:'service',items:[{quantity:2,sentQuantity:0}]})
    expect((await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches).toHaveLength(0)
  })

  it('rolls back the payment and paid quantities if the kitchen batch cannot commit',async()=>{
    const actor=await newActor();await activate(actor);await open(actor)
    const product=await newProduct(actor), order=await newOrder(actor,product)
    let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
    const complete={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete' as const,confirmed:true as const,reason:'Pago sintético recibido'}
    await db.exec("create function app_private.reject_test_batch() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Test kitchen failure'; end $$; create trigger reject_test_batch before insert on app_private.kitchen_batches for each row execute function app_private.reject_test_batch();")
    try {
      await expect(execute(actor,complete)).rejects.toThrow()
      expect((await db.query<{count:number}>('select count(*)::integer count from app_private.sales where business_id=$1',[actor.businessId])).rows[0].count).toBe(0)
      expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({items:[{paidQuantity:0,sentQuantity:0}],frozen:false})
      expect(await execute(actor,{command:'attempt',attemptId:attempt.id})).toMatchObject({status:'collection_started',revision:attempt.revision})
    } finally { await db.exec('drop trigger reject_test_batch on app_private.kitchen_batches; drop function app_private.reject_test_batch();') }
    expect(await execute(actor,complete)).toMatchObject({status:'completed'})
    expect((await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches).toHaveLength(1)
  })

  it('removes original unsent lines and refills the same empty account with exact revision and retry protection',async()=>{
    const owner=await newActor();await activate(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner), water=await newProduct(owner,2500)
    let order=await newOrder(cashier,product)
    const originalLineId=order.items[0].lineId
    const remaining={lineId:randomUUID(),productId:water.id,quantity:2,unitPriceCents:water.priceCents,version:water.version,note:'Sin hielo'}
    order=await execute(cashier,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[{lineId:originalLineId,productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version,note:''},remaining]})
    order=await execute(cashier,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[remaining]})
    expect(order).toMatchObject({revision:3,totalCents:5000,items:[{lineId:remaining.lineId,quantity:2,note:'Sin hielo',unitPriceCents:2500}]})
    expect(order.items).toHaveLength(1)
    const remove={command:'save_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[]}
    const empty=await execute<OperationalOrder>(cashier,remove)
    expect(empty).toMatchObject({id:order.id,revision:4,status:'open',phase:'service',frozen:false,items:[],grossCents:0,totalCents:0,taxCents:0,balanceCents:0})
    expect(await execute(cashier,remove)).toEqual(empty)
    await expect(execute(cashier,{...remove,operationId:randomUUID()})).rejects.toThrow('ORDER_CHANGED')
    await expect(execute(cashier,{command:'begin_order_checkout',operationId:randomUUID(),orderId:empty.id,expectedRevision:empty.revision})).rejects.toThrow('VALIDATION_ERROR')
    await expect(execute(cashier,{...remove,operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null})).rejects.toThrow('VALIDATION_ERROR')
    const refilled=await execute<OperationalOrder>(cashier,{...remove,operationId:randomUUID(),expectedRevision:empty.revision,items:[{...remaining,lineId:randomUUID(),quantity:1}]})
    expect(refilled).toMatchObject({id:order.id,revision:5,totalCents:2500,items:[{quantity:1,note:'Sin hielo'}]})
    expect(await execute(cashier,remove)).toEqual(empty)
    expect(await execute(cashier,{command:'order',orderId:order.id})).toEqual(refilled)
    const other=await newActor();await activate(other)
    await expect(execute(other,{...remove,operationId:randomUUID(),expectedRevision:refilled.revision})).rejects.toThrow('ORDER_CHANGED')
    expect((await db.query<{count:number}>('select count(*)::integer count from app_private.sales where business_id=$1',[owner.businessId])).rows[0].count).toBe(0)
    await db.query('update app_private.employees set permissions=$1 where id=$2',[['catalog.read'],cashier.employeeId])
    await expect(execute(cashier,remove)).rejects.toThrow(/SESSION_INVALID|PERMISSION_DENIED/)
  })

  it('clears an emptied account discount without applying it to replacement items',async()=>{
    const actor=await newActor();await activate(actor);const product=await newProduct(actor)
    let order=await newOrder(actor,product)
    order=await execute(actor,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:500,reason:'Cortesía sintética'}})
    const empty=await execute<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[]})
    expect(empty).toMatchObject({discount:null,discountCents:0,totalCents:0,taxCents:0,items:[]})
    const refilled=await execute<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:empty.id,expectedRevision:empty.revision,name:empty.name,tableId:null,items:[{lineId:randomUUID(),productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version,note:''}]})
    expect(refilled).toMatchObject({discount:null,discountCents:0,totalCents:product.priceCents})
  })

  it('rejects empty edits of sent or checkout accounts without losing preparation or paid history',async()=>{
    const actor=await newActor();await activate(actor);await open(actor);const product=await newProduct(actor)
    let sent=await newOrder(actor,product)
    sent=await execute(actor,{command:'send_order',operationId:randomUUID(),orderId:sent.id,expectedRevision:sent.revision})
    const emptyEdit=(order:OperationalOrder)=>({command:'save_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[]})
    const kitchenBefore=await execute(actor,{command:'kitchen'})
    await expect(execute(actor,emptyEdit(sent))).rejects.toThrow('ORDER_LOCKED')
    expect(await execute(actor,{command:'kitchen'})).toEqual(kitchenBefore)
    let order=await newOrder(actor,product,2)
    order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    await expect(execute(actor,emptyEdit(order))).rejects.toThrow('ORDER_LOCKED')
    let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
    attempt=await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Pago sintético recibido'})
    order=await execute(actor,{command:'order',orderId:order.id})
    await expect(execute(actor,emptyEdit(order))).rejects.toThrow('ORDER_LOCKED')
    expect(await execute(actor,{command:'sale',saleId:attempt.saleId!})).toMatchObject({totalCents:product.priceCents})
    expect(await execute(actor,{command:'order',orderId:order.id})).toEqual(order)
  })

  it('keeps legacy sales compatible until explicit owner activation, including accepted retries after cutover',async()=>{
    const actor=await newActor();const product=await newProduct(actor)
    const command={command:'complete_sale' as const,operationId:randomUUID(),paymentMethod:'cash' as const,totalCents:product.priceCents,items:[{productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version}]}
    const receipt=await execute<Sale>(actor,command)
    expect(await execute(actor,{command:'operations'})).toMatchObject({enabled:false,shift:null})
    await activate(actor)
    expect(await execute(actor,command)).toEqual(receipt)
    await expect(execute(actor,{...command,operationId:randomUUID()})).rejects.toThrow('LEGACY_CHECKOUT_DISABLED')
    expect((await db.query<{count:number}>('select count(*)::integer count from app_private.sales where business_id=$1',[actor.businessId])).rows[0].count).toBe(1)
  })

  it('authorizes current grants before replays, rejects another tenant, and keeps private schema unavailable',async()=>{
    const owner=await newActor();await activate(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner);const order=await newOrder(cashier,product)
    expect(await execute(cashier,{command:'operations'})).toMatchObject({orders:[{id:order.id}]})
    await expect(execute(cashier,{command:'orders'})).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(cashier,{command:'open_shift',operationId:randomUUID(),openingCents:0})).rejects.toThrow('PERMISSION_DENIED')
    const other=await newActor();await activate(other)
    await expect(execute(other,{command:'order',orderId:order.id})).rejects.toThrow('ORDER_NOT_FOUND')
    const command={command:'begin_order_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}
    await execute(cashier,command)
    await db.query('update app_private.employees set permissions=$1 where id=$2',[['catalog.read'],cashier.employeeId])
    await expect(execute(cashier,command)).rejects.toThrow(/SESSION_INVALID|PERMISSION_DENIED/)
    await expect(db.query('select app_private.pos_command($1,$2,$3::jsonb)',[owner.businessId,cashier.employeeId,JSON.stringify(command)])).rejects.toThrow('PERMISSION_DENIED')
    for(const role of ['anon','authenticated']) {
      const rights=(await db.query<{allowed:boolean}>("select has_table_privilege($1,'app_private.checkout_attempts','SELECT') or has_function_privilege($1,'app_private.pos_command(uuid,uuid,jsonb)','EXECUTE') as allowed",[role])).rows[0]
      expect(rights.allowed).toBe(false)
    }
  })

  it('persists immutable batches, revision conflicts, queued cancellation notices and owner waiver for prepared food',async()=>{
    const actor=await newActor();await activate(actor);const product=await newProduct(actor)
    let order=await newOrder(actor,product,2)
    const send={command:'send_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}
    order=await execute(actor,send);expect(await execute(actor,send)).toEqual(order)
    const first=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches[0]
    expect(first.items[0].quantity).toBe(2)
    await expect(execute(actor,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[{lineId:order.items[0].lineId,productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version,note:''}]})).rejects.toThrow('ORDER_LOCKED')
    order=await execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cliente cancela antes de preparar'})
    expect(order.status).toBe('cancelled')
    const batches=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches
    expect(batches.find(b=>b.id===first.id)).toEqual({...first,revision:first.revision+1,fullyCancelled:true,items:first.items.map(item=>({...item,cancelledQuantity:item.quantity}))});expect(batches.find(b=>b.kind==='cancellation')?.items[0].quantity).toBe(2)
    let prepared=await newOrder(actor,product)
    prepared=await execute(actor,{command:'send_order',operationId:randomUUID(),orderId:prepared.id,expectedRevision:prepared.revision})
    const batch=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches.find(b=>b.orderId===prepared.id)!
    await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'delivered'})
    await expect(execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:prepared.id,expectedRevision:prepared.revision,reason:'No borrar consumo preparado'})).rejects.toThrow('ORDER_LOCKED')
    const waiver=await execute<BalanceWaiver>(actor,{command:'prepare_waiver',operationId:randomUUID(),orderId:prepared.id,expectedRevision:prepared.revision,reason:'Absorción autorizada'})
    expect(waiver.amountCents).toBe(product.priceCents)
    const accepted=await execute<BalanceWaiver>(actor,{command:'confirm_waiver',operationId:randomUUID(),waiverId:waiver.id,expectedRevision:waiver.revision,confirmed:true})
    expect(accepted.status).toBe('completed');expect(await execute(actor,{command:'order',orderId:prepared.id})).toMatchObject({status:'waived',balanceCents:0,waivedCents:product.priceCents})
  })

  it('freezes checkout before splitting, preserves every discount/IVA cent, ignores later catalog changes and retains original actor on recovery',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner,1001)
    let order=await newOrder(cashier,product,3)
    order=await execute(owner,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:1000,reason:'Descuento de cuenta'}})
    expect(order).toMatchObject({grossCents:3003,discountCents:1000,totalCents:2003,taxCents:276})
    order=await execute(cashier,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    await execute(owner,{command:'set_product_sold_out',operationId:randomUUID(),productId:product.id,expectedVersion:product.version,soldOut:true})
    const paid:CheckoutAttempt[]=[]
    for(let index=0;index<3;index++) {
      const prepared=await execute<CheckoutAttempt>(cashier,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:index===0?'cash':'card_external'})
      await expect(execute(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:prepared.shiftId,expectedRevision:1})).rejects.toThrow('PENDING_COLLECTION')
      let started=await execute<CheckoutAttempt>(cashier,{command:'start_checkout',operationId:randomUUID(),attemptId:prepared.id,expectedRevision:prepared.revision})
      if(index===0) started=await execute(cashier,{command:'mark_checkout_uncertain',operationId:randomUUID(),attemptId:started.id,expectedRevision:started.revision})
      const resolution={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:started.id,expectedRevision:started.revision,resolution:'complete' as const,confirmed:true as const,reason:'Cobro confirmado manualmente'}
      const accepted=await execute<CheckoutAttempt>(owner,resolution);expect(await execute(owner,resolution)).toEqual(accepted);paid.push(accepted)
      expect(accepted.operatorName).toBe('Cajero sintético');expect(accepted.resolverName).toBe('Propietario sintético')
      order=await execute(owner,{command:'order',orderId:order.id})
      if(index===0) await expect(execute(cashier,{command:'resume_order_service',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})).rejects.toThrow('ORDER_LOCKED')
    }
    expect(paid.map(p=>p.totalCents)).toEqual([668,668,667]);expect(paid.reduce((n,p)=>n+p.taxCents,0)).toBe(276);expect(paid.reduce((n,p)=>n+p.discountCents,0)).toBe(1000)
    expect(order).toMatchObject({status:'paid',frozen:true,balanceCents:0,paidCents:2003})
    const receipt=await execute<Sale>(owner,{command:'sale',saleId:paid[0].saleId!});expect(receipt.items[0]).toMatchObject({totalCents:668,taxCents:92,unitPriceCents:1001,name:product.name})
    const totals=(await db.query<{total:string;tax:string;discount:string}>('select sum(total_cents)::text total,sum(tax_cents)::text tax,sum(discount_cents)::text discount from app_private.sale_items where business_id=$1',[owner.businessId])).rows[0]
    expect(totals).toEqual({total:'2003',tax:'276',discount:'1000'})
  })

  it('settles a fully discounted account with zero cash and tax before explicit table closure',async()=>{
    const actor=await newActor();await activate(actor);await open(actor,5000)
    const product=await newProduct(actor)
    const table=await execute<DiningTable>(actor,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa cortesía',active:true})
    let order=await newOrder(actor,product,1,table.id)
    order=await execute(actor,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'percent',value:10000,reason:'Cortesía autorizada'}})
    expect(order).toMatchObject({status:'open',totalCents:0,taxCents:0,balanceCents:0})
    await expect(execute(actor,{command:'close_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})).rejects.toThrow('ORDER_LOCKED')
    const settled=await pay(actor,order,'cash')
    expect(settled).toMatchObject({totalCents:0,taxCents:0,discountCents:product.priceCents,status:'completed'})
    order=await execute(actor,{command:'order',orderId:order.id})
    expect(order).toMatchObject({status:'paid',items:[{paidQuantity:1}],frozen:true})
    expect(await execute(actor,{command:'close_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})).toMatchObject({status:'closed'})
    const shift=(await execute<{shifts:CashShift[]}>(actor,{command:'shifts'})).shifts[0]
    const counting=await execute<CashShift>(actor,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    expect(await execute(actor,{command:'close_shift',operationId:randomUUID(),shiftId:shift.id,expectedRevision:counting.revision,countedCents:5000})).toMatchObject({expectedCents:5000,differenceCents:0})
  })

  it('requires an open shift, hides expected cash until submitted count, serializes movements and closes with exact difference',async()=>{
    const actor=await newActor();await activate(actor);const product=await newProduct(actor,11600)
    let order=await newOrder(actor,product);order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    for (const paymentMethod of ['cash','card_external','transfer'] as const) {
      await expect(execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod})).rejects.toThrow('SHIFT_REQUIRED')
    }
    expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({paidCents:0,balanceCents:11600,items:[{paidQuantity:0}]})
    let shift=await open(actor,5000)
    shift=await execute(actor,{command:'cash_movement',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,kind:'out',amountCents:1000,reason:'Gasto de caja'})
    await pay(actor,order,'cash')
    shift=await execute(actor,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    expect(shift).toMatchObject({status:'closing',expectedCents:null,differenceCents:null,countedCents:null})
    const another=await newOrder(actor,product);const checkout=await execute<OperationalOrder>(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:another.id,expectedRevision:another.revision})
    for (const paymentMethod of ['cash','card_external','transfer'] as const) {
      await expect(execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:checkout.id,expectedRevision:checkout.revision,items:[{lineId:checkout.items[0].lineId,quantity:1}],paymentMethod})).rejects.toThrow('SHIFT_NOT_OPEN')
    }
    await expect(execute(actor,{command:'cash_movement',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,kind:'in',amountCents:1000,reason:'No durante conteo'})).rejects.toThrow('SHIFT_NOT_OPEN')
    const close={command:'close_shift' as const,operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,countedCents:15550}
    const closed=await execute<CashShift>(actor,close);expect(await execute(actor,close)).toEqual(closed)
    expect(closed).toMatchObject({status:'closed',expectedCents:15600,countedCents:15550,differenceCents:-50})
    const day=(await db.query<{day:string}>("select to_char(clock_timestamp() at time zone 'America/Mexico_City','YYYY-MM-DD') as \"day\"")).rows[0].day
    expect(await execute(actor,{command:'report',date:day})).toMatchObject({salesCents:11600,taxCents:1600,cashDifferences:[{differenceCents:-50}]})
  })

  it('records full external/cash reversals only on confirmed resolution and their effective business day without changing sales',async()=>{
    const actor=await newActor();await activate(actor);await open(actor)
    const product=await newProduct(actor,11600);const original=await newOrder(actor,product)
    const receipt=await pay(actor,original,'card_external')
    const before=await execute(actor,{command:'sale',saleId:receipt.saleId!})
    let reversal=await execute<CheckoutAttempt>(actor,{command:'prepare_reversal',operationId:randomUUID(),saleId:receipt.saleId!,reason:'Devolución completa'})
    await expect(execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision,resolution:'complete',confirmed:true,reason:'Reembolso externo confirmado'})).rejects.toThrow('ATTEMPT_STATE_INVALID')
    reversal=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision})
    const operation={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision,resolution:'complete' as const,confirmed:true as const,reason:'Reembolso externo confirmado'}
    reversal=await execute(actor,operation);expect(await execute(actor,operation)).toEqual(reversal)
    await expect(execute(actor,{command:'prepare_reversal',operationId:randomUUID(),saleId:receipt.saleId!,reason:'No duplicar'})).rejects.toThrow('SALE_ALREADY_REVERSED')
    expect(await execute(actor,{command:'sale',saleId:receipt.saleId!})).toEqual(before)
    const day=(await db.query<{day:string}>("select to_char(clock_timestamp() at time zone 'America/Mexico_City','YYYY-MM-DD') as \"day\"")).rows[0].day
    const report=await execute<BusinessDayReport>(actor,{command:'report',date:day})
    expect(report).toMatchObject({salesCents:11600,reversalCents:11600,reversalTaxCents:1600,netCents:0})
    expect(report.payments.find(p=>p.paymentMethod==='card_external')).toMatchObject({salesCents:11600,reversalCents:11600,netCents:0})
    await db.query("update app_private.sales set created_at=created_at-interval '1 day' where id=$1",[receipt.saleId])
    expect(await execute(actor,{command:'report',date:day})).toMatchObject({salesCents:0,reversalCents:11600,netCents:-11600})
  })

  it('keeps table occupancy through payment and releases only by explicit move or close',async()=>{
    const actor=await newActor();await activate(actor);await open(actor);const product=await newProduct(actor)
    const table=await execute<DiningTable>(actor,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa 1',active:true})
    let order=await newOrder(actor,product,1,table.id)
    await expect(newOrder(actor,product,1,table.id)).rejects.toThrow('TABLE_OCCUPIED')
    await pay(actor,order,'cash');order=await execute(actor,{command:'order',orderId:order.id})
    expect(await execute(actor,{command:'tables'})).toMatchObject({tables:[{orderId:order.id}]})
    await expect(newOrder(actor,product,1,table.id)).rejects.toThrow('TABLE_OCCUPIED')
    order=await execute(actor,{command:'close_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    expect(order.status).toBe('closed');expect((await newOrder(actor,product,1,table.id)).tableId).toBe(table.id)
  })

  it('cancels only the unpaid queued remainder, keeps immutable receipts and table occupation until close',async()=>{
    const actor=await newActor();await activate(actor);await open(actor);const product=await newProduct(actor)
    const table=await execute<DiningTable>(actor,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa cancelación',active:true})
    let order=await newOrder(actor,product,3,table.id)
    order=await execute(actor,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
    attempt=await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Primer artículo pagado'})
    const receipt=await execute(actor,{command:'sale',saleId:attempt.saleId!})
    order=await execute(actor,{command:'order',orderId:order.id})
    const cancel={command:'cancel_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Resto no preparado cancelado'}
    order=await execute(actor,cancel);expect(await execute(actor,cancel)).toEqual(order)
    expect(order).toMatchObject({status:'cancelled',paidCents:1001,cancelledCents:2002,balanceCents:0,items:[{paidQuantity:1,quantity:3}]})
    expect(await execute(actor,{command:'sale',saleId:attempt.saleId!})).toEqual(receipt)
    expect((await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches.find(b=>b.kind==='cancellation')?.items[0].quantity).toBe(2)
    await expect(newOrder(actor,product,1,table.id)).rejects.toThrow('TABLE_OCCUPIED')
    await execute(actor,{command:'close_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    expect((await newOrder(actor,product,1,table.id)).tableId).toBe(table.id)
  })

  it('keeps accepted counter retries after table moves while authorizing fresh commands against the current table',async()=>{
    const owner=await newActor();await activate(owner);await open(owner)
    const cashier=await newActor(owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const product=await newProduct(owner)
    const save={command:'save_order' as const,operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta de mostrador',tableId:null,items:[{lineId:randomUUID(),productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version,note:''}]}
    let order=await execute<OperationalOrder>(cashier,save);const originalOrder=order
    const begin={command:'begin_order_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}
    order=await execute(cashier,begin);const originalCheckout=order
    const prepare={command:'prepare_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash' as const}
    let attempt=await execute<CheckoutAttempt>(cashier,prepare);const originalAttempt=attempt
    const start={command:'start_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}
    attempt=await execute(cashier,start)
    await execute(owner,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'abort',confirmed:true,reason:'No se recibió dinero'})
    order=await execute(owner,{command:'order',orderId:order.id})
    const table=await execute<DiningTable>(owner,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa movida',active:true})
    order=await execute(owner,{command:'move_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,tableId:table.id})
    expect(await execute(cashier,save)).toEqual(originalOrder)
    expect(await execute(cashier,begin)).toEqual(originalCheckout)
    expect(await execute(cashier,prepare)).toEqual(originalAttempt)
    await expect(execute(cashier,{...prepare,operationId:randomUUID(),expectedRevision:order.revision})).rejects.toThrow('PERMISSION_DENIED')
    expect(await execute(owner,{command:'order',orderId:order.id})).toMatchObject({tableId:table.id,revision:order.revision})
  })

  it('allocates tiny discounted IVA without putting tax on a zero-value bill and permits complete tenant cleanup',async()=>{
    const actor=await newActor();await activate(actor);await open(actor);const product=await newProduct(actor,1)
    let order=await newOrder(actor,product,7)
    order=await execute(actor,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:3,reason:'Centavos sintéticos'}})
    expect(order).toMatchObject({totalCents:4,taxCents:1})
    order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    const receipts:CheckoutAttempt[]=[]
    for(let n=0;n<7;n++) {
      let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
      attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
      attempt=await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Pago de centavo'})
      expect(attempt.taxCents).toBeLessThanOrEqual(attempt.totalCents);receipts.push(attempt)
      order=await execute(actor,{command:'order',orderId:order.id})
    }
    expect(receipts.reduce((s,r)=>s+r.taxCents,0)).toBe(1);expect(receipts.reduce((s,r)=>s+r.totalCents,0)).toBe(4)
    let reversal=await execute<CheckoutAttempt>(actor,{command:'prepare_reversal',operationId:randomUUID(),saleId:receipts[0].saleId!,reason:'Centavo devuelto'})
    reversal=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision})
    await execute(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision,resolution:'complete',confirmed:true,reason:'Dinero devuelto'})
    await db.query('delete from app_private.businesses where id=$1',[actor.businessId])
    expect((await db.query<{count:number}>('select count(*)::integer count from app_private.checkout_attempts where business_id=$1',[actor.businessId])).rows[0].count).toBe(0)
  })

  it('prevents stale balance waivers, preserves partial receipts, and rolls back sale plus paid units if result persistence fails',async()=>{
    const actor=await newActor();await activate(actor);await open(actor);const product=await newProduct(actor)
    let order=await newOrder(actor,product,3)
    order=await execute(actor,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    const batch=(await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches[0]
    await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'delivered'})
    const stale=await execute<BalanceWaiver>(actor,{command:'prepare_waiver',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Saldo anterior'})
    order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
    await expect(execute(actor,{command:'confirm_waiver',operationId:randomUUID(),waiverId:stale.id,expectedRevision:stale.revision,confirmed:true})).rejects.toThrow('WAIVER_CHANGED')
    let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
    attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
    const resolve={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete' as const,confirmed:true as const,reason:'Dinero recibido'}
    await db.exec(`create function app_private.fail_lean_result() returns trigger language plpgsql set search_path='' as $$ begin if new.result->>'status'='completed' then raise exception 'synthetic persistence failure'; end if; return new; end; $$;
      create trigger fail_lean_result before insert on app_private.pos_operations for each row execute function app_private.fail_lean_result();`)
    try {
      await expect(execute(actor,resolve)).rejects.toThrow('synthetic persistence failure')
      expect(await execute(actor,{command:'attempt',attemptId:attempt.id})).toMatchObject({status:'collection_started',saleId:null})
      expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({paidCents:0,items:[{paidQuantity:0}]})
    } finally {await db.exec('drop trigger fail_lean_result on app_private.pos_operations; drop function app_private.fail_lean_result();')}
    const paid=await execute<CheckoutAttempt>(actor,resolve)
    order=await execute(actor,{command:'order',orderId:order.id})
    await expect(execute(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'No borrar consumo preparado'})).rejects.toThrow('ORDER_LOCKED')
    const waiver=await execute<BalanceWaiver>(actor,{command:'prepare_waiver',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Saldo absorbido'})
    expect(waiver.amountCents).toBe(2*product.priceCents)
    await execute(actor,{command:'confirm_waiver',operationId:randomUUID(),waiverId:waiver.id,expectedRevision:waiver.revision,confirmed:true})
    expect(await execute(actor,{command:'sale',saleId:paid.saleId!})).toMatchObject({totalCents:product.priceCents})
    expect(await execute(actor,{command:'order',orderId:order.id})).toMatchObject({paidCents:product.priceCents,waivedCents:2*product.priceCents,balanceCents:0,status:'waived'})
  })
})

async function newActor(existingBusiness?:string,permissions?:string[]):Promise<Actor> {
 const role=existingBusiness?'cashier':'owner';const actor={userId:randomUUID(),sessionId:randomUUID(),businessId:existingBusiness??randomUUID(),employeeId:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),keyHash:randomUUID().replaceAll('-','').repeat(2)}
 await db.query('insert into auth.users(id) values($1)',[actor.userId]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[actor.sessionId,actor.userId])
 if(!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash","card_external","transfer"]}')`,[actor.businessId])
 await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)',[actor.businessId,actor.userId,role])
 await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,$4,$5,$6)',[actor.employeeId,actor.businessId,actor.userId,existingBusiness?'Cajero sintético':'Propietario sintético',role,permissions??[]])
 await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`,[actor.businessId,actor.userId,actor.sessionId,actor.token])
 if(existingBusiness){await db.query(`insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')`,[actor.businessId,actor.employeeId,actor.keyHash]);await db.query('update app_private.operator_sessions set employee_device_key_hash=decode($1,\'hex\') where business_id=$2 and user_id=$3',[actor.keyHash,actor.businessId,actor.userId])}
 return actor
}
async function execute<T=unknown>(actor:Actor,command:PosCommand):Promise<T> {
 const result=(await db.query<{result:{data:T;error?:{code:string}}}>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result",[actor.userId,actor.sessionId,JSON.stringify({action:'pos',businessId:actor.businessId,operatorToken:actor.token,...command}),actor.keyHash,randomUUID()])).rows[0].result
 if(result.error) throw new Error(result.error.code);return result.data
}
async function reportAt(actor:Actor,date:string,period:'day'|'week'|'month',asOf:string):Promise<BusinessPeriodReport> {
 return (await db.query<{report:BusinessPeriodReport}>('select app_private.ops_period_report_at($1,$2::date,$3,$4::timestamptz) report',[actor.businessId,date,period,asOf])).rows[0].report
}
async function activate(actor:Actor){await execute(actor,{command:'activate_operations',operationId:randomUUID()})}
async function open(actor:Actor,openingCents=0){return execute<CashShift>(actor,{command:'open_shift',operationId:randomUUID(),openingCents})}
async function newProduct(actor:Actor,priceCents=1001){return execute<Product>(actor,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Café sintético',category:'Bebidas',priceCents,details:{...emptyDetails(),taxTreatment:'vat_16',taxBps:1600,kitchenName:'Café cocina'}})}
async function newOrder(actor:Actor,product:Product,quantity=1,tableId:string|null=null){return execute<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Mostrador sintético',tableId,items:[{lineId:randomUUID(),productId:product.id,quantity,unitPriceCents:product.priceCents,version:product.version,note:''}]})}
async function pay(actor:Actor,order:OperationalOrder,paymentMethod:'cash'|'card_external'|'transfer') {
 if(order.phase==='service') order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
 let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:order.items.filter(i=>i.quantity>i.paidQuantity).map(i=>({lineId:i.lineId,quantity:i.quantity-i.paidQuantity})),paymentMethod})
 attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
 return execute<CheckoutAttempt>(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Pago confirmado'})
}

async function reserve(actor:Actor,order:OperationalOrder,quantity:number):Promise<CheckoutAttempt> {
 return execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity}],paymentMethod:'cash'})
}
