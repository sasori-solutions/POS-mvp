import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { permissionPrerequisites } from '../../src/lib/contracts'
import type { PosCommand, Product } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, DiningTable, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

let db:PGlite, owner:Actor, tablesOnly:Actor, oldDeviceId:string
type Actor={userId:string;sessionId:string;businessId:string;employeeId:string;token:string;keyHash:string}
const migration='20261002002200_operational_review_fixes.sql'

describe('final operational migration review regressions',()=>{
 beforeAll(async()=>{
  db=new PGlite({extensions:{pgcrypto}})
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
   create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f<migration).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
  owner=await actor(); tablesOnly=await actor(owner.businessId,['tables.manage'])
  oldDeviceId=randomUUID()
  await db.query("insert into app_private.devices(id,business_id,name,register_name,token_hash) values($1,$2,'Caja sintética','Caja',extensions.digest($3,'sha256'))",[oldDeviceId,owner.businessId,'ab'.repeat(32)])
  await db.query("insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))",[owner.businessId,oldDeviceId,tablesOnly.employeeId,'bc'.repeat(32)])
  await db.exec(readFileSync(`supabase/migrations/${migration}`,'utf8'))
 },60_000)
 afterAll(async()=>{await db?.close()})

 it('normalizes legacy standalone table grants and revokes both live operator credentials',async()=>{
  expect((await db.query<{permissions:string[]}>('select permissions from app_private.employees where id=$1',[tablesOnly.employeeId])).rows[0].permissions).toEqual(['tables.manage','orders.read'])
  expect((await db.query<{live:number}>('select count(*)::integer live from app_private.operator_sessions where business_id=$1 and user_id=$2 and revoked_at is null',[owner.businessId,tablesOnly.userId])).rows[0].live).toBe(0)
  expect((await db.query<{live:number}>('select count(*)::integer live from app_private.device_operator_sessions where device_id=$1 and employee_id=$2 and revoked_at is null',[oldDeviceId,tablesOnly.employeeId])).rows[0].live).toBe(0)
  await expect(execute(tablesOnly,{command:'operations'})).rejects.toThrow('SESSION_INVALID')
  expect((await db.query<{validated:boolean}>("select convalidated validated from pg_constraint where conrelid='app_private.employees'::regclass and conname='employee_permissions_known'")).rows[0].validated).toBe(true)
  expect((await db.query<{live:number}>('select count(*)::integer live from app_private.operator_sessions where business_id=$1 and user_id=$2 and revoked_at is null',[owner.businessId,owner.userId])).rows[0].live).toBe(1)
 })

 it('enforces the same table prerequisite in HTTP/SQL/check constraints and exposes operations after fresh unlock',async()=>{
  expect(permissionPrerequisites['tables.manage']).toBe('orders.read')
  const request={action:'create_employee',businessId:owner.businessId,operatorToken:owner.token,operationId:randomUUID(),name:'Mesas sintético',role:'cashier',pin:null,inviteWithGoogle:true,permissions:['tables.manage']}
  expect(()=>parseAccountRequest(request)).toThrow()
  expect(parseAccountRequest({...request,permissions:['tables.manage','orders.read']})).toHaveProperty('permissions',['orders.read','tables.manage'])
  await expect(db.query('select app_private.validate_employee_permissions($1::jsonb)',[JSON.stringify(['tables.manage'])])).rejects.toThrow('VALIDATION_ERROR')
  await expect(db.query('update app_private.employees set permissions=$1 where id=$2',[['tables.manage'],tablesOnly.employeeId])).rejects.toThrow('employee_permissions_known')
  await execute(owner,{command:'activate_operations',operationId:randomUUID()})
  // Synthetic unlock creates a new credential after migration revoked the old one.
  tablesOnly.token=randomUUID().replaceAll('-','').repeat(2)
  await operator(tablesOnly,true)
  const table=await execute<DiningTable>(tablesOnly,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa accesible',active:true})
  const product=await newProduct(owner)
  let order=await newOrder(owner,product,table.id)
  expect(await execute(tablesOnly,{command:'operations'})).toMatchObject({enabled:true,tables:[{id:table.id,orderId:order.id}],orders:[{id:order.id}]})
  expect(await execute(tablesOnly,{command:'tables'})).toMatchObject({tables:[{id:table.id}]})
  order=await execute(owner,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cerrar cuenta no preparada'})
  expect(await execute(tablesOnly,{command:'close_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})).toMatchObject({status:'closed'})
 })

 it('keeps older pending kitchen work before over one hundred recently delivered batches',async()=>{
  const person=await actor();await execute(person,{command:'activate_operations',operationId:randomUUID()})
  const product=await newProduct(person),order=await newOrder(person,product)
  const pending:string[]=[]
  for(const [index,status] of ['queued','preparing','ready'].entries()) {
   const id=randomUUID();pending.push(id)
   await db.query("insert into app_private.kitchen_batches(business_id,id,order_id,order_name,kind,status,items,actor_id,actor_name,created_at) values($1,$2,$3,'Orden sintética','items',$4,$5::jsonb,$6,'Operador sintético',clock_timestamp()-interval '10 days'+$7::integer*interval '1 minute')",[person.businessId,id,order.id,status,JSON.stringify([{lineId:order.items[0].lineId,name:'Producto',selectionLabel:'',note:'',quantity:1}]),person.employeeId,index])
  }
  await db.query("insert into app_private.kitchen_batches(business_id,order_id,order_name,kind,status,items,actor_id,actor_name,created_at) select $1,$2,'Orden sintética','items','delivered',$3::jsonb,$4,'Operador sintético',clock_timestamp()-n*interval '1 minute' from generate_series(1,120) n",[person.businessId,order.id,JSON.stringify([{lineId:order.items[0].lineId,name:'Producto',selectionLabel:'',note:'',quantity:1}]),person.employeeId])
  const batches=(await execute<{batches:KitchenBatch[]}>(person,{command:'kitchen'})).batches
  expect(batches).toHaveLength(100)
  expect(batches.filter(b=>b.status!=='delivered').map(b=>b.id)).toEqual(pending)
  expect(batches.filter(b=>b.status==='delivered')).toHaveLength(97)
  await db.query("insert into app_private.kitchen_batches(business_id,order_id,order_name,kind,status,items,actor_id,actor_name,created_at) select $1,$2,'Orden sintética','items','queued',$3::jsonb,$4,'Operador sintético',clock_timestamp()+n*interval '1 second' from generate_series(1,105) n",[person.businessId,order.id,JSON.stringify([{lineId:order.items[0].lineId,name:'Producto',selectionLabel:'',note:'',quantity:1}]),person.employeeId])
  const full=(await execute<{batches:KitchenBatch[]}>(person,{command:'kitchen'})).batches
  expect(full).toHaveLength(100);expect(full.some(b=>b.status==='delivered')).toBe(false)
  expect(full.slice(0,3).map(b=>b.id)).toEqual(pending)
 })

 it('records a zero-value account as paid using quantities and creates an immutable zero-value receipt',async()=>{
  const person=await actor();await execute(person,{command:'activate_operations',operationId:randomUUID()})
  await execute(person,{command:'open_shift',operationId:randomUUID(),openingCents:0})
  const product=await newProduct(person,0)
  let order=await newOrder(person,product)
  order=await execute(person,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision})
  let attempt=await execute<CheckoutAttempt>(person,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'})
  expect(attempt).toMatchObject({totalCents:0,taxCents:0})
  attempt=await execute(person,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision})
  const resolve={command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete' as const,confirmed:true as const,reason:'Cortesía confirmada'}
  attempt=await execute(person,resolve);expect(await execute(person,resolve)).toEqual(attempt)
  expect(await execute(person,{command:'order',orderId:order.id})).toMatchObject({status:'paid',frozen:true,balanceCents:0,items:[{paidQuantity:1}]})
  expect(await execute(person,{command:'sale',saleId:attempt.saleId!})).toMatchObject({totalCents:0,itemCount:1,items:[{totalCents:0,quantity:1}]})
 })
})

async function actor(existingBusiness?:string,permissions:string[]=[]):Promise<Actor>{
 const value={userId:randomUUID(),sessionId:randomUUID(),businessId:existingBusiness??randomUUID(),employeeId:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),keyHash:randomUUID().replaceAll('-','').repeat(2)},role=existingBusiness?'cashier':'owner'
 await db.query('insert into auth.users(id) values($1)',[value.userId]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[value.sessionId,value.userId])
 if(!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash","card_external","transfer"]}')`,[value.businessId])
 await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)',[value.businessId,value.userId,role])
 await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Operador sintético',$4,$5)",[value.employeeId,value.businessId,value.userId,role,permissions])
 if(existingBusiness) await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')",[value.businessId,value.employeeId,value.keyHash])
 await operator(value,!!existingBusiness);return value
}
async function operator(value:Actor,personal:boolean){await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),case when $5 then decode($6,'hex') else null end)",[value.businessId,value.userId,value.sessionId,value.token,personal,value.keyHash])}
async function execute<T=unknown>(value:Actor,command:PosCommand):Promise<T>{
 const result=(await db.query<{result:{data:T;error?:{code:string}}}>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result",[value.userId,value.sessionId,JSON.stringify({action:'pos',businessId:value.businessId,operatorToken:value.token,...command}),value.keyHash,randomUUID()])).rows[0].result
 if(result.error)throw new Error(result.error.code);return result.data
}
async function newProduct(value:Actor,priceCents=100){return execute<Product>(value,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Producto sintético',category:'',priceCents})}
async function newOrder(value:Actor,product:Product,tableId:string|null=null){return execute<OperationalOrder>(value,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Orden sintética',tableId,items:[{lineId:randomUUID(),productId:product.id,quantity:1,unitPriceCents:product.priceCents,version:product.version,note:''}]})}
