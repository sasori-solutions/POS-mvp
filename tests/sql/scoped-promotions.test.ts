import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { emptyDetails, includedTax } from '../../src/lib/product-details'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Promotion, PromotionCommand, PromotionScope } from '../../src/lib/promotion-contracts'

type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite
describe('scoped promotions on accepted order snapshots', () => {
 beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && file <= '20261007190000_scoped_promotions.sql').sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
 }, 90_000)
 afterAll(async () => { await db?.close() })

 it('matches canonical categories against legacy NFD snapshots and allocates odd cents only to eligible lines once', async () => {
  const { owner, first, second, other, order } = await fixture()
  const scope = { productIds: [first.id], categories: ['Café'] }
  const discounted = await execute<OperationalOrder>(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount: { kind: 'fixed', value: 1, reason: 'Ajuste', scope } })
  expect(discounted.discountCents).toBe(1)
  expect(discounted.items.find(line => line.productId === first.id)).toMatchObject({ category: 'Cafe\u0301', discountCents: 1, totalCents: 2001, taxCents: includedTax(2001,1600) })
  expect(discounted.items.find(line => line.productId === second.id)?.discountCents).toBe(0)
  expect(discounted.items.find(line => line.productId === other.id)?.discountCents).toBe(0)
  expect(discounted.totalCents).toBe(3103)
  const percent = await execute<OperationalOrder>(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: discounted.revision, discount: { kind: 'percent', value: 3333, reason: 'Tercio', scope } })
  expect(percent.discountCents).toBe(1001)
  expect(percent.items.find(line => line.productId === other.id)).toMatchObject({ discountCents: 0, totalCents: 101 })
  expect(percent.items.filter(line => line.productId !== other.id).reduce((sum,line) => sum+line.discountCents,0)).toBe(1001)
  const foreign = await actor(), foreignProduct = await product(foreign,'Café',1)
  await expect(execute(owner,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:percent.revision,discount:{kind:'fixed',value:1,reason:'Ajeno',scope:{productIds:[foreignProduct.id],categories:['Café']}}})).rejects.toThrow('PRODUCT_CHANGED')
 })

 it('captures the library revision, rejects stale applications and returns the original replay after edits, pause and completed split payment', async () => {
  const { owner, first, second, other, order } = await fixture()
  const create = promotion({ productIds: [first.id, second.id].sort(), categories: [] }, 5)
  const saved = await execute<Promotion>(owner, create)
  const apply = { command: 'apply_order_promotion' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, promotionId: saved.id, promotionRevision: saved.revision }
  let discounted = await execute<OperationalOrder>(owner, apply)
  const acceptedDiscount = discounted
  expect(discounted.discount).toMatchObject({ kind: 'fixed', value: 5, scope: saved.scope, promotion: { id: saved.id, revision: 1, name: saved.name } })
  await execute(owner, { ...create, operationId: randomUUID(), expectedRevision: 1, name: 'Oferta posterior', active: false, value: 999 })
  expect(await execute(owner, create)).toEqual(saved)
  expect(await execute(owner, apply)).toEqual(discounted)
  await expect(execute(owner, { ...apply, operationId: randomUUID(), expectedRevision: discounted.revision })).rejects.toThrow('PROMOTION_CHANGED')
  await expect(execute(owner, { ...apply, operationId: randomUUID(), promotionRevision: 2, expectedRevision: discounted.revision })).rejects.toThrow('PROMOTION_NOT_APPLICABLE')
  await execute(owner, { command: 'save_product', operationId: randomUUID(), productId: first.id, expectedVersion: first.version, name: 'Nombre posterior', category: 'Otro', priceCents: 99999, details: first.details })
  discounted = await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: discounted.revision })
  const quote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: discounted.revision, paymentMethod: 'cash', items: [{ lineId: discounted.items.find(line => line.productId === first.id)!.lineId, quantity: 1 }] })
  const payment = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
  const paid = await execute<{ attempt: CheckoutAttempt; order: OperationalOrder }>(owner, payment)
  expect(await execute(owner, payment)).toEqual(paid)
  const remaining = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: paid.order.revision, paymentMethod: 'transfer', items: [{ lineId: paid.order.items.find(line => line.productId === first.id)!.lineId, quantity: 1 }, { lineId: paid.order.items.find(line => line.productId === second.id)!.lineId, quantity: 1 }, { lineId: paid.order.items.find(line => line.productId === other.id)!.lineId, quantity: 1 }] })
  expect(quote.discountCents+remaining.discountCents).toBe(5)
  expect(quote.totalCents+remaining.totalCents).toBe(3099)
  expect(quote.taxCents+remaining.taxCents).toBe(discounted.taxCents)
  const final = await execute<{ attempt: CheckoutAttempt; order: OperationalOrder }>(owner, { command: 'record_checkout', operationId: randomUUID(), attemptId: remaining.id, expectedRevision: remaining.revision, confirmed: true })
  expect(final.order.status).toBe('closed')
  expect(final.order.discount).toEqual(discounted.discount)
  expect(await execute(owner, apply)).toEqual(acceptedDiscount)
  const receipt = await execute<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! })
  expect(receipt.items[0]).toMatchObject({ category: 'Cafe\u0301', unitPriceCents: 1001, discountCents: quote.discountCents, totalCents: quote.totalCents })
  await expect(execute(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: final.order.revision, discount: null })).rejects.toThrow('ORDER_LOCKED')
  const checks = (await db.query<{ result: Record<string, number> }>('select app_private.ops_financial_ledger_check() result')).rows[0].result
  expect(Object.values(checks).every(value => value === 0)).toBe(true)
 })

 it('checks tenant and current permissions before library replay and permits a cashier to apply without catalogue management', async () => {
  const { owner, first, order } = await fixture(), foreign = await actor(), cashier = await actor(owner.businessId, ['catalog.read','sales.create','sales.discount'])
  const create = promotion({ productIds: [first.id], categories: [] }, 1), saved = await execute<Promotion>(owner, create)
  await expect(execute(cashier, { ...create, operationId: randomUUID(), promotionId: randomUUID() })).rejects.toThrow('PERMISSION_DENIED')
  await expect(execute(foreign, { ...create, operationId: randomUUID(), promotionId: randomUUID() })).rejects.toThrow('PRODUCT_CHANGED')
  await expect(execute(foreign, { command: 'apply_order_promotion', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, promotionId: saved.id, promotionRevision: 1 })).rejects.toThrow('PROMOTION_NOT_FOUND')
  expect((await execute<{ promotions: Promotion[] }>(cashier, { command: 'promotions' })).promotions).toHaveLength(1)
  const apply = { command: 'apply_order_promotion' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, promotionId: saved.id, promotionRevision: 1 }
  await execute(cashier, apply)
  await db.query("update app_private.employees set permissions='{}' where business_id=$1 and id=$2", [cashier.businessId,cashier.employeeId])
  await expect(execute(cashier, apply)).rejects.toThrow('SESSION_INVALID')
  cashier.token=randomUUID().replaceAll('-','').repeat(2)
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))",[cashier.businessId,cashier.userId,cashier.sessionId,cashier.token,cashier.keyHash])
  await expect(execute(cashier, apply)).rejects.toThrow('PERMISSION_DENIED')
  await expect(execute(owner, { ...create, name: 'Huella diferente' })).rejects.toThrow('OPERATION_CONFLICT')
  for (const role of ['anon','authenticated']) {
   expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'app_private.promotions','select') allowed",[role])).rows[0].allowed).toBe(false)
   expect((await db.query<{ allowed: boolean }>("select bool_or(has_function_privilege($1,p.oid,'execute')) allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in ('promotion_category','validate_promotion_scope','promotion_matches','validate_scoped_discount','promotion_json','promotion_operation_uuid','pos_command')",[role])).rows[0].allowed).toBe(false)
  }
 })

 it('rejects unknown keys, forged library metadata, no matching/zero eligible lines and excessive fixed amounts atomically', async () => {
  const { owner, first, order } = await fixture()
  const baseline = await execute<OperationalOrder>(owner, { command: 'order', orderId: order.id })
  for (const scope of [{ productIds: [], categories: [] }, { productIds: [first.id,first.id], categories: [] }, { productIds: [], categories: ['Café'], extra: true }]) {
   await expect(raw(owner, { ...promotion(scope as PromotionScope,1) })).rejects.toThrow('VALIDATION_ERROR')
  }
  const notApplicable = await execute<Promotion>(owner,promotion({productIds:[],categories:['Sin coincidencia']},1))
  const apply = {command:'apply_order_promotion' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,promotionId:notApplicable.id,promotionRevision:1}
  await expect(execute(owner,apply)).rejects.toThrow('PROMOTION_NOT_APPLICABLE')
  expect((await db.query<{count:number}>('select count(*)::integer count from app_private.pos_operations where business_id=$1 and operation_id in ($2,$3)',[owner.businessId,apply.operationId,(await db.query<{id:string}>('select app_private.promotion_operation_uuid($1::uuid) id',[apply.operationId])).rows[0].id])).rows[0].count).toBe(0)
  expect(await execute(owner,{command:'order',orderId:order.id})).toEqual(baseline)
  for (const discount of [
   { kind: 'fixed', value: 2003, reason: 'Exceso', scope: { productIds: [first.id], categories: [] } },
   { kind: 'percent', value: 1000, reason: 'Sin coincidencia', scope: { productIds: [], categories: ['Inexistente'] } },
   { kind: 'fixed', value: 1, reason: 'Forjado', scope: { productIds: [first.id], categories: [] }, promotion: { id: randomUUID(), revision: 1, name: 'Forjada' } },
  ]) {
   const command = { command: 'set_order_discount', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, discount }
   await expect(raw(owner, command)).rejects.toThrow(/VALIDATION_ERROR|PROMOTION_NOT_APPLICABLE/)
   expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.pos_operations where business_id=$1 and operation_id=$2',[owner.businessId,command.operationId])).rows[0].count).toBe(0)
   expect(await execute(owner, { command: 'order', orderId: order.id })).toEqual(baseline)
  }
  const zero = await product(owner,'Gratis',0), zeroOrder = await execute<OperationalOrder>(owner, orderCommand([zero]))
  await expect(execute(owner, { command: 'set_order_discount', operationId: randomUUID(), orderId: zeroOrder.id, expectedRevision: zeroOrder.revision, discount: { kind: 'percent', value: 1000, reason: 'Gratis', scope: { productIds: [zero.id], categories: [] } } })).rejects.toThrow('PROMOTION_NOT_APPLICABLE')
 })

 it('retains accepted manual replay and permits the same-tenant archived product snapshot without using current price or status', async () => {
  const {owner,first,order}=await fixture()
  const command={command:'set_order_discount' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed' as const,value:1,reason:'Ajuste manual',scope:{productIds:[first.id],categories:[]}}}
  const accepted=await execute<OperationalOrder>(owner,command)
  await db.query('update app_private.products set active=false,deleted_at=now(),price_cents=99999,version=version+1 where business_id=$1 and id=$2',[owner.businessId,first.id])
  expect(await execute(owner,command)).toEqual(accepted)
  const adjusted=await execute<OperationalOrder>(owner,{...command,operationId:randomUUID(),expectedRevision:accepted.revision,discount:{...command.discount,value:2}})
  expect(adjusted.items.find(line=>line.productId===first.id)).toMatchObject({unitPriceCents:1001,discountCents:2})
 })
})

function promotion(scope: PromotionScope, value: number): Extract<PromotionCommand,{command:'save_promotion'}> {
 return { command:'save_promotion',operationId:randomUUID(),promotionId:randomUUID(),expectedRevision:null,name:'Oferta sintética',active:true,kind:'fixed',value,scope }
}
async function fixture() {
 const owner = await actor(), first = await product(owner,'Cafe\u0301',1001), second = await product(owner,'Café',1001), other = await product(owner,'Pan',101)
 await execute(owner,{command:'activate_operations',operationId:randomUUID()}); await execute(owner,{command:'open_shift',operationId:randomUUID(),openingCents:0})
 const order = await execute<OperationalOrder>(owner,orderCommand([first,second,other]))
 return {owner,first,second,other,order}
}
async function product(owner: Actor,category: string,priceCents: number) {
 return execute<Product>(owner,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Producto sintético',category,priceCents,details:{...emptyDetails(),taxTreatment:'vat_16',taxBps:1600}})
}
function orderCommand(products: Product[]): Extract<PosCommand,{command:'save_order'}> {
 return { command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta sintética',tableId:null,orderKind:'service',items:products.map((product,index)=>({lineId:randomUUID(),productId:product.id,quantity:index===0&&products.length>1?2:1,unitPriceCents:product.priceCents,version:product.version,note:''})) }
}
async function execute<T = unknown>(current: Actor,command: PosCommand|PromotionCommand): Promise<T> {
 const envelope = {action:'pos',businessId:current.businessId,operatorToken:current.token,...command}
 parseAccountRequest(envelope)
 return raw<T>(current,command)
}
async function raw<T = unknown>(current: Actor,command: Record<string,unknown>): Promise<T> {
 const result = (await db.query<{result:{data:T;error?:{code:string}}}>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result",[current.userId,current.sessionId,JSON.stringify({action:'pos',businessId:current.businessId,operatorToken:current.token,...command}),current.keyHash,randomUUID()])).rows[0].result
 if(result.error) throw new Error(result.error.code)
 return result.data
}
async function actor(existingBusiness?: string,permissions: string[]=[]): Promise<Actor> {
 const role = existingBusiness?'cashier':'owner', current = {userId:randomUUID(),sessionId:randomUUID(),businessId:existingBusiness??randomUUID(),employeeId:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),keyHash:randomUUID().replaceAll('-','').repeat(2)}
 await db.query('insert into auth.users(id) values($1)',[current.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[current.sessionId,current.userId])
 if(!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Café sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","accountsEnabled":true,"paymentMethods":["cash","card_external","transfer"]}')`,[current.businessId])
 await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)',[current.businessId,current.userId,role])
 await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,$4,$5,$6)',[current.employeeId,current.businessId,current.userId,'Operador sintético',role,permissions])
 await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`,[current.businessId,current.userId,current.sessionId,current.token])
 if(existingBusiness) {
  await db.query(`insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')`,[current.businessId,current.employeeId,current.keyHash])
  await db.query("update app_private.operator_sessions set employee_device_key_hash=decode($1,'hex') where business_id=$2 and user_id=$3",[current.keyHash,current.businessId,current.userId])
 }
 return current
}
