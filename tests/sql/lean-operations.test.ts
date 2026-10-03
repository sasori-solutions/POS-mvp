import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { CashShift, OperationalOrder, CheckoutAttempt, BalanceWaiver, BusinessDayReport, KitchenBatch, DiningTable } from '../../src/lib/operations-contracts'
import { emptyDetails } from '../../src/lib/product-details'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }

describe('Lean POS private transactions with real PostgreSQL migrations', () => {
  beforeAll(async () => {
    db=new PGlite({extensions:{pgcrypto}})
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
  },60_000)
  afterAll(async()=>{await db?.close()})

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
    await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'preparing'})
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
    await expect(execute(cashier,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})).rejects.toThrow('ORDER_LOCKED')
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
    await expect(execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})).rejects.toThrow('SHIFT_REQUIRED')
    let shift=await open(actor,5000)
    shift=await execute(actor,{command:'cash_movement',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,kind:'out',amountCents:1000,reason:'Gasto de caja'})
    await pay(actor,order,'cash')
    shift=await execute(actor,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision})
    expect(shift).toMatchObject({status:'closing',expectedCents:null,differenceCents:null,countedCents:null})
    const another=await newOrder(actor,product);const checkout=await execute<OperationalOrder>(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:another.id,expectedRevision:another.revision})
    await expect(execute(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:checkout.id,expectedRevision:checkout.revision,items:[{lineId:checkout.items[0].lineId,quantity:1}],paymentMethod:'card_external'})).rejects.toThrow('SHIFT_NOT_OPEN')
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
    await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'preparing'})
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
