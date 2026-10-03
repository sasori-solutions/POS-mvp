import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { BusinessDayReport, CheckoutAttempt, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

let db:PGlite
type Actor={userId:string;sessionId:string;businessId:string;employeeId:string;token:string;keyHash:string}
type Legacy={actor:Actor;order:OperationalOrder;batch:KitchenBatch;report:BusinessDayReport}
let coherent:Legacy,incompatible:Legacy
const migration='20261002002300_kitchen_cancellation_overlay.sql'

describe('atomic immutable kitchen cancellation overlay',()=>{
 beforeAll(async()=>{
  db=new PGlite({extensions:{pgcrypto}})
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
   create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f<migration).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,3);order=await send(actor,order)
  const batch=await batchFor(actor,order.id)
  await pay(actor,order,1);order=await getOrder(actor,order.id)
  order=await cancel(actor,order)
  coherent={actor,order,batch,report:await report(actor)}
  const bad=await fixture(),badProduct=await newProduct(bad)
  let badOrder=await newOrder(bad,badProduct,1);badOrder=await send(bad,badOrder)
  let badBatch=await batchFor(bad,badOrder.id)
  badOrder=await cancel(bad,badOrder)
  // Reproduce the pre-0023 defect in the disposable fixture before upgrading.
  badBatch=await execute(bad,{command:'set_kitchen_status',operationId:randomUUID(),batchId:badBatch.id,expectedRevision:badBatch.revision,status:'preparing'})
  incompatible={actor:bad,order:badOrder,batch:badBatch,report:await report(bad)}
  await db.exec(readFileSync(`supabase/migrations/${migration}`,'utf8'))
 },60_000)
 afterAll(async()=>{await db?.close()})

 it('backfills coherent queued cancellation without reconstructing advanced preparation or changing money',async()=>{
  const batch=await batchFor(coherent.actor,coherent.order.id,'items')
  expect(batch).toMatchObject({status:'queued',fullyCancelled:false,revision:coherent.batch.revision+1,items:[{quantity:3,cancelledQuantity:2}]})
  expect(await report(coherent.actor)).toEqual(coherent.report)
  const bad=await batchFor(incompatible.actor,incompatible.order.id,'items')
  expect(bad).toMatchObject({status:'preparing',revision:incompatible.batch.revision,fullyCancelled:false,items:[{quantity:1,cancelledQuantity:0}]})
  expect(await report(incompatible.actor)).toEqual(incompatible.report)
  expect((await db.query<{count:number}>('select count(*)::integer count from app_private.kitchen_cancellations where business_id=$1',[incompatible.actor.businessId])).rows[0].count).toBe(0)
  const cancellation=(await db.query<{id:string}>('select id from app_private.order_cancellations where business_id=$1',[coherent.actor.businessId])).rows[0].id
  await db.query('select app_private.ops_apply_kitchen_cancellation($1,$2,true)',[coherent.actor.businessId,cancellation])
  expect(await batchFor(coherent.actor,coherent.order.id,'items')).toEqual(batch)
 })

 it('fully cancels queued work, rejects stale and current preparation taps, and acknowledges notices independently',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,3);order=await send(actor,order)
  const original=await batchFor(actor,order.id),rawBefore=await rawBatch(actor,original.id)
  const command={command:'cancel_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cuenta completa sin preparar'}
  order=await execute(actor,command);expect(await execute(actor,command)).toEqual(order)
  const batch=await batchFor(actor,order.id,'items')
  expect(batch).toMatchObject({status:'queued',revision:original.revision+1,fullyCancelled:true,items:[{quantity:3,cancelledQuantity:3}]})
  expect((await rawBatch(actor,original.id)).items).toEqual(rawBefore.items)
  for(const expectedRevision of [original.revision,batch.revision]) await expect(execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision,status:'preparing'})).rejects.toThrow('BATCH_CHANGED')
  const notice=await batchFor(actor,order.id,'cancellation')
  expect(notice).toMatchObject({fullyCancelled:false,items:[{quantity:3,cancelledQuantity:0}]})
  await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:notice.id,expectedRevision:notice.revision,status:'delivered'})
  expect(await batchFor(actor,order.id,'items')).toEqual(batch)
  expect((await db.query<{pending:boolean}>('select app_private.ops_batch_pending(b) pending from app_private.kitchen_batches b where b.business_id=$1 and b.id=$2',[actor.businessId,batch.id])).rows[0].pending).toBe(false)
  expect(await report(actor)).toMatchObject({salesCents:0,netCents:0,reversalCents:0,waivedCents:0})
 })

 it('keeps exactly the paid unit executable after canceling two of three queued units through all four states',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,3);order=await send(actor,order)
  const original=await batchFor(actor,order.id),rawBefore=await rawBatch(actor,original.id)
  const receipt=await pay(actor,order,1),before=await report(actor)
  order=await cancel(actor,await getOrder(actor,order.id))
  expect(order).toMatchObject({paidCents:1001,cancelledCents:2002,balanceCents:0})
  let batch=await batchFor(actor,order.id,'items')
  expect(batch).toMatchObject({fullyCancelled:false,revision:original.revision+1,items:[{quantity:3,cancelledQuantity:2}]})
  await expect(execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:original.revision,status:'preparing'})).rejects.toThrow('BATCH_CHANGED')
  for(const status of ['preparing','ready','delivered'] as const) {
   batch=await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status})
   expect(batch.items[0].quantity-(batch.items[0].cancelledQuantity??0)).toBe(1)
  }
  expect((await rawBatch(actor,original.id)).items).toEqual(rawBefore.items)
  expect(await report(actor)).toEqual(before)
  expect(await execute(actor,{command:'sale',saleId:receipt.saleId!})).toMatchObject({totalCents:1001,itemCount:1})
 })

 it('excludes a newer prepared paid batch while canceling older queued unpaid quantities',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,2);order=await send(actor,order)
  const older=await batchFor(actor,order.id)
  order=await resize(actor,order,product,3);order=await send(actor,order)
  let newer=(await batches(actor)).find(b=>b.orderId===order.id&&b.id!==older.id)!
  newer=await execute(actor,{command:'set_kitchen_status',operationId:randomUUID(),batchId:newer.id,expectedRevision:newer.revision,status:'preparing'})
  await pay(actor,order,1);const before=await report(actor)
  await cancel(actor,await getOrder(actor,order.id))
  const current=await batches(actor)
  expect(current.find(b=>b.id===older.id)).toMatchObject({fullyCancelled:true,revision:older.revision+1,items:[{quantity:2,cancelledQuantity:2}]})
  expect(current.find(b=>b.id===newer.id)).toMatchObject({fullyCancelled:false,status:'preparing',revision:newer.revision,items:[{quantity:1,cancelledQuantity:0}]})
  expect(await report(actor)).toEqual(before)
 })

 it('consumes unsent cancellations first, then cancels newest queued units deterministically',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,1);order=await send(actor,order)
  const older=await batchFor(actor,order.id)
  order=await resize(actor,order,product,3);order=await send(actor,order)
  const newer=(await batches(actor)).find(b=>b.orderId===order.id&&b.id!==older.id)!
  order=await resize(actor,order,product,5)
  await pay(actor,order,2);await cancel(actor,await getOrder(actor,order.id))
  const current=await batches(actor)
  expect(current.find(b=>b.id===older.id)).toMatchObject({revision:older.revision,items:[{quantity:1,cancelledQuantity:0}]})
  expect(current.find(b=>b.id===newer.id)).toMatchObject({revision:newer.revision+1,items:[{quantity:2,cancelledQuantity:1}]})
  expect(current.find(b=>b.kind==='cancellation')).toMatchObject({items:[{quantity:1,cancelledQuantity:0}]})
  expect((await db.query<{quantity:number}>('select sum(quantity)::integer quantity from app_private.kitchen_cancellations where business_id=$1',[actor.businessId])).rows[0].quantity).toBe(1)
 })

 it('rolls back cancellation, overlay, revision and notice when the accepted response cannot commit',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,2);order=await send(actor,order)
  const batch=await batchFor(actor,order.id)
  const command={command:'cancel_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cancelación atómica'}
  await db.exec(`create function app_private.fail_kitchen_response() returns trigger language plpgsql set search_path='' as $$ begin if new.result->>'status'='cancelled' then raise exception 'synthetic persistence failure'; end if; return new; end; $$;
   create trigger fail_kitchen_response before insert on app_private.pos_operations for each row execute function app_private.fail_kitchen_response();`)
  try {
   await expect(execute(actor,command)).rejects.toThrow('synthetic persistence failure')
   expect(await getOrder(actor,order.id)).toMatchObject({status:'open',revision:order.revision,cancelledCents:0})
   expect(await batchFor(actor,order.id)).toEqual(batch)
   expect((await db.query<{count:number}>('select count(*)::integer count from app_private.kitchen_cancellations where business_id=$1',[actor.businessId])).rows[0].count).toBe(0)
   expect((await batches(actor)).some(b=>b.kind==='cancellation')).toBe(false)
  } finally {await db.exec('drop trigger fail_kitchen_response on app_private.pos_operations; drop function app_private.fail_kitchen_response();')}
  await execute(actor,command)
  expect((await db.query<{count:number}>('select count(*)::integer count from app_private.kitchen_cancellations where business_id=$1',[actor.businessId])).rows[0].count).toBe(1)
 })

 it('denies browser access, cross-tenant overlays and excludes fully canceled history from active capacity',async()=>{
  const actor=await fixture(),product=await newProduct(actor)
  let order=await newOrder(actor,product,1);order=await send(actor,order);await cancel(actor,order)
  const batch=await batchFor(actor,order.id,'items')
  const other=await fixture()
  const cancellation=(await db.query<{id:string}>('select id from app_private.order_cancellations where business_id=$1',[actor.businessId])).rows[0].id
  await expect(db.query('insert into app_private.kitchen_cancellations(business_id,batch_id,order_id,line_id,cancellation_id,quantity) values($1,$2,$3,$4,$5,1)',[other.businessId,batch.id,order.id,order.items[0].lineId,cancellation])).rejects.toThrow(/foreign key/)
  for(const role of ['anon','authenticated']) expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'app_private.kitchen_cancellations','SELECT') or has_function_privilege($1,'app_private.ops_apply_kitchen_cancellation(uuid,uuid,boolean)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false)
  expect((await db.query<{enabled:boolean}>("select relrowsecurity enabled from pg_class where oid='app_private.kitchen_cancellations'::regclass")).rows[0].enabled).toBe(true)
  const active=await newOrder(actor,product)
  await db.query("insert into app_private.kitchen_batches(business_id,order_id,order_name,kind,items,actor_id,actor_name,created_at) select $1,$2,'Activa sintética','items',$3::jsonb,$4,'Operador sintético',clock_timestamp()+n*interval '1 second' from generate_series(1,100) n",[actor.businessId,active.id,JSON.stringify([{lineId:active.items[0].lineId,name:'Producto',selectionLabel:'',note:'',quantity:1}]),actor.employeeId])
  const visible=await batches(actor)
  expect(visible).toHaveLength(100);expect(visible.some(b=>b.id===batch.id)).toBe(false)
  expect((await rawBatch(actor,batch.id)).items[0].quantity).toBe(1)
  await db.query('delete from app_private.businesses where id=$1',[actor.businessId])
  expect((await db.query<{count:number}>('select count(*)::integer count from app_private.kitchen_cancellations where business_id=$1',[actor.businessId])).rows[0].count).toBe(0)
 })
})

async function fixture():Promise<Actor>{
 const actor={userId:randomUUID(),sessionId:randomUUID(),businessId:randomUUID(),employeeId:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),keyHash:randomUUID().replaceAll('-','').repeat(2)}
 await db.query('insert into auth.users(id) values($1)',[actor.userId]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[actor.sessionId,actor.userId])
 await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash","card_external","transfer"]}')`,[actor.businessId])
 await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')",[actor.businessId,actor.userId])
 await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Operador sintético','owner')",[actor.employeeId,actor.businessId,actor.userId])
 await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))",[actor.businessId,actor.userId,actor.sessionId,actor.token])
 await execute(actor,{command:'activate_operations',operationId:randomUUID()});await execute(actor,{command:'open_shift',operationId:randomUUID(),openingCents:0});return actor
}
async function execute<T=unknown>(actor:Actor,command:PosCommand):Promise<T>{
 const result=(await db.query<{result:{data:T;error?:{code:string}}}>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result",[actor.userId,actor.sessionId,JSON.stringify({action:'pos',businessId:actor.businessId,operatorToken:actor.token,...command}),actor.keyHash,randomUUID()])).rows[0].result
 if(result.error)throw new Error(result.error.code);return result.data
}
async function newProduct(actor:Actor){return execute<Product>(actor,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Producto sintético',category:'',priceCents:1001})}
async function newOrder(actor:Actor,product:Product,quantity=1){return execute<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Orden sintética',tableId:null,items:[{lineId:randomUUID(),productId:product.id,quantity,unitPriceCents:product.priceCents,version:product.version,note:''}]})}
async function resize(actor:Actor,order:OperationalOrder,product:Product,quantity:number){return execute<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[{lineId:order.items[0].lineId,productId:product.id,quantity,unitPriceCents:product.priceCents,version:product.version,note:''}]})}
async function send(actor:Actor,order:OperationalOrder){return execute<OperationalOrder>(actor,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})}
async function getOrder(actor:Actor,orderId:string){return execute<OperationalOrder>(actor,{command:'order',orderId})}
async function batches(actor:Actor){return (await execute<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches}
async function batchFor(actor:Actor,orderId:string,kind:KitchenBatch['kind']='items'){return (await batches(actor)).find(b=>b.orderId===orderId&&b.kind===kind)!}
async function cancel(actor:Actor,order:OperationalOrder){return execute<OperationalOrder>(actor,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Sin preparar cancelado'})}
async function rawBatch(actor:Actor,id:string){return (await db.query<{items:{quantity:number}[]}>('select items from app_private.kitchen_batches where business_id=$1 and id=$2',[actor.businessId,id])).rows[0]}
async function pay(actor:Actor,order:OperationalOrder,quantity:number){
 order=await execute(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
 let attempt=await execute<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity}],paymentMethod:'cash'})
 attempt=await execute(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
 return execute<CheckoutAttempt>(actor,{command:'resolve_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete',confirmed:true,reason:'Dinero recibido'})
}
async function report(actor:Actor){const date=(await db.query<{day:string}>("select to_char(clock_timestamp() at time zone 'America/Mexico_City','YYYY-MM-DD') as \"day\"")).rows[0].day;return execute<BusinessDayReport>(actor,{command:'report',date})}
