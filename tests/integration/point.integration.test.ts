import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OperatorSession } from '../../src/lib/contracts'
import type { OperationalOrder, CheckoutAttempt } from '../../src/lib/operations-contracts'
import type { PointCheckout, PointCommand, PointSettings, PointReport } from '../../src/lib/point-contracts'
import type { Product } from '../../src/lib/pos-contracts'
import { signedRequest } from './device-proof-fixture'

const url = process.env.TEST_SUPABASE_URL, simulator = process.env.TEST_POINT_SIMULATOR_URL
const enabled = Boolean(url && simulator)
if (enabled && (process.env.TEST_DISPOSABLE_SUPABASE !== 'true' || ![url!, simulator!].every(value => new URL(value).protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(new URL(value).hostname)))) throw new Error('Point integration requires explicitly disposable loopback services')
const anon = process.env.TEST_SUPABASE_ANON_KEY ?? '', service = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? ''
const workerSecret = process.env.TEST_POINT_WORKER_SECRET ?? 'point-worker-local-synthetic-secret-2026'
type Actor = { userId: string; jwt: string; operator: OperatorSession }
let owner: Actor, other: Actor, product: Product
const users: string[] = [], businesses: string[] = []
const admin = enabled ? createClient(url!,service,{ auth:{persistSession:false,autoRefreshToken:false} }) : null
const terminalId = 'NEWLAND_N950__SERIAL-1'
function sql(statement: string) {
  return execFileSync('docker',['exec','-i',process.env.TEST_LOCAL_DB_CONTAINER ?? 'supabase_db_pos-mexico-pwa','psql','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'],{input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()
}
function literal(value: string) { return `'${value.replaceAll("'","''")}'` }
async function raw(actor: Actor | undefined, payload: Record<string,unknown>) {
  return fetch(`${url}/functions/v1/account`,{method:'POST',headers:{'content-type':'application/json',apikey:anon,origin:process.env.TEST_APP_ORIGIN ?? 'http://127.0.0.1:5173',...(actor?{authorization:`Bearer ${actor.jwt}`}:{})},body:JSON.stringify(await signedRequest(actor?.userId,payload)),signal:AbortSignal.timeout(15000)})
}
async function call<T>(actor: Actor | undefined, payload: Record<string,unknown>): Promise<{status:number;data?:T;error?:{code:string}}> {
  const response = await raw(actor,payload), body = await response.json()
  return {status:response.status,...body}
}
function data<T>(reply:{status:number;data?:T;error?:{code:string}}):T { expect(reply.error).toBeUndefined();expect(reply.status).toBe(200);expect(reply.data).toBeDefined();return reply.data! }
function access(actor:Actor) { return {businessId:actor.operator.business.id,operatorToken:actor.operator.operatorToken} }
async function point<T>(actor:Actor,command:PointCommand) { return call<T>(actor,{action:'point',...access(actor),...command}) }
async function pos<T>(actor:Actor,command:Record<string,unknown>) { return call<T>(actor,{action:'pos',...access(actor),...command}) }
async function control(payload:Record<string,unknown>) { const response=await fetch(`${simulator}/__control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});expect(response.status).toBe(200);return response.json() }
async function stats() { return (await fetch(`${simulator}/__control`)).json() }
async function worker() {
  const response=await fetch(`${url}/functions/v1/point-worker`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${workerSecret}`,apikey:anon},body:'{"limit":20}',signal:AbortSignal.timeout(55000)})
  expect(response.status).toBe(200);return response.json()
}
async function runUntil(checkoutId:string,predicate:(c:PointCheckout)=>boolean) {
  let result:PointCheckout | undefined
  for(let attempt=0;attempt<6;attempt++) {
    sql(`update app_private.point_jobs set available_at=clock_timestamp() where business_id=${literal(owner.operator.business.id)}::uuid and status='queued';`)
    await worker();result=data(await point<PointCheckout>(owner,{command:'status',checkoutId}))
    if(predicate(result)) return result
  }
  const state=sql(`select jsonb_build_object('state',state,'old',observed_at<clock_timestamp()-interval '5 minutes','reconciled',last_reconciled_at,'now',clock_timestamp()) from app_private.point_attempts where id=${literal(result?.attemptId ?? '')}::uuid;`)
  const errors=sql(`select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'status',status,'error',last_error)),'[]') from app_private.point_jobs where attempt_id=${literal(result?.attemptId ?? '')}::uuid;`)
  throw new Error(`Point reconciliation did not reach the required state (${result?.state}): ${errors} ${state}`)
}
async function actor():Promise<Actor> {
  const email=`point-${randomUUID()}@example.test`,password=`Local-${randomUUID()}-Aa9!`
  const created=await admin!.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error
  users.push(created.data.user.id)
  const auth=createClient(url!,anon,{auth:{persistSession:false,autoRefreshToken:false}})
  const signed=await auth.auth.signInWithPassword({email,password});if(signed.error)throw signed.error
  const temporary={userId:created.data.user.id,jwt:signed.data.session!.access_token} as Actor
  const operator=data(await call<OperatorSession>(temporary,{action:'create_business',operationId:randomUUID(),name:'Point integración sintética',businessType:'cafe',timezone:'America/Mexico_City',pin:'583927',profile:{branchName:'Local',registerName:'Caja',address:'',city:'',state:'',contactPhone:'',paymentMethods:['cash','card_external','transfer']}}))
  businesses.push(operator.business.id);return {...temporary,operator}
}
async function reserve(actor=owner) {
  const order=data(await pos<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta Point',tableId:null,items:[{lineId:randomUUID(),productId:product.id,version:product.version,unitPriceCents:product.priceCents,quantity:1,note:''}]}))
  const checkout=data(await pos<CheckoutAttempt>(actor,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:order.items.map(i=>({lineId:i.lineId,quantity:i.quantity})),paymentMethod:'card_integrated'}))
  return data(await point<PointCheckout>(actor,{command:'prepare',operationId:randomUUID(),checkoutAttemptId:checkout.id,terminalId}))
}

describe.skipIf(!enabled)('Point real Auth/Edge/PostgreSQL with HTTP provider simulator',()=>{
  beforeAll(async()=>{
    await control({reset:process.env.TEST_POINT_PERSISTENT !== 'true',scenario:'approved',terminalMode:'PDV'})
    owner=await actor();other=await actor()
    data(await pos(owner,{command:'activate_operations',operationId:randomUUID()}))
    data(await pos(owner,{command:'open_shift',operationId:randomUUID(),openingCents:0}))
    product=data(await pos<Product>(owner,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Producto Point',category:'Café',priceCents:1001}))
  },60000)
  afterAll(async()=>{
    // Only this suite's synthetic tenants. Financial rows are intentionally immutable;
    // suppress their test-only deletion triggers within the cleanup transaction.
    if(businesses.length) {
      const ids=businesses.map(id=>`${literal(id)}::uuid`).join(',')
      const tables=['point_event_inbox','point_statement_lines','point_commission_payments','point_statements','point_fee_ledger','point_jobs','point_refunds','point_refund_requests','point_terminal_reservations','point_incidents','point_operations','point_checkouts','point_attempts','point_terminals','point_oauth_states','point_connections','point_settings']
      sql(`begin;set local session_replication_role=replica;${tables.map(table=>`delete from app_private.${table} where business_id in (${ids});`).join('')}set local session_replication_role=origin;delete from app_private.businesses where id in (${ids});commit;`)
    }
    for(const id of users){const deleted=await admin!.auth.admin.deleteUser(id);if(deleted.error)throw deleted.error}
  },60000)

  it('keeps account protected and consumes OAuth state only for the original authorized tenant',async()=>{
    expect(await call(undefined,{action:'point',...access(owner),command:'settings'})).toMatchObject({status:401,error:{code:'AUTH_REQUIRED'}})
    expect(data(await point<PointSettings>(owner,{command:'settings'}))).toMatchObject({enabled:false,connection:null})
    const expired=data(await point<{authorizationUrl:string}>(owner,{command:'oauth_start',operationId:randomUUID()}))
    const expiredState=new URL(expired.authorizationUrl).searchParams.get('state')!
    sql(`update app_private.point_oauth_states set expires_at=clock_timestamp()-interval '1 second' where state_hash=extensions.digest(${literal(expiredState)},'sha256');`)
    expect(await point(owner,{command:'oauth_callback',code:'sim-code',state:expiredState})).toMatchObject({status:400,error:{code:'POINT_OAUTH_INVALID'}})
    const denied=data(await point<{authorizationUrl:string}>(owner,{command:'oauth_start',operationId:randomUUID()}))
    const deniedState=new URL(denied.authorizationUrl).searchParams.get('state')!
    data(await point(owner,{command:'oauth_callback',error:'access_denied',state:deniedState}))
    expect(await point(owner,{command:'oauth_callback',code:'sim-code',state:deniedState})).toMatchObject({status:400,error:{code:'POINT_OAUTH_INVALID'}})
    const begin=data(await point<{authorizationUrl:string;expiresAt:string}>(owner,{command:'oauth_start',operationId:randomUUID(),environment:'sandbox'}))
    const state=new URL(begin.authorizationUrl).searchParams.get('state')!
    expect(new URL(begin.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256')
    expect(await point(other,{command:'oauth_callback',code:'sim-code',state})).toMatchObject({status:400,error:{code:'POINT_OAUTH_INVALID'}})
    expect(await point(owner,{command:'oauth_callback',code:'sim-code',state:'x'.repeat(43)})).toMatchObject({status:400,error:{code:'POINT_OAUTH_INVALID'}})
    const connected=data(await point<PointSettings>(owner,{command:'oauth_callback',code:'sim-code',state}))
    expect(connected.connection?.environment).toBe('sandbox')
    expect(JSON.stringify(connected)).not.toMatch(/sim-access|sim-refresh|ciphertext|clientSecret|backendDirective/)
    expect(await point(owner,{command:'oauth_callback',code:'sim-code',state})).toMatchObject({status:400,error:{code:'POINT_OAUTH_INVALID'}})
    const verified=data(await point<PointSettings>(owner,{command:'verify_connection'}))
    expect(verified.connection?.verifiedAt).toBeTruthy()
    const resources=data(await point<{branches:{id:string}[];registers:{id:string}[]}>(owner,{command:'resources'}))
    expect(resources.branches[0].id).toBe('STORE-1');expect(resources.registers[0].id).toBe('POS-1')
    data(await point(owner,{command:'link_terminal',operationId:randomUUID(),serial:'SERIAL-1',branchId:'STORE-1',registerId:'POS-1'}))
    expect(await point(owner,{command:'activate',enabled:true})).toMatchObject({status:409,error:{code:'POINT_TERMINAL_NOT_READY'}})
    data(await point(owner,{command:'test_terminal',terminalId}))
    expect(data(await point<PointSettings>(owner,{command:'activate',enabled:true})).enabled).toBe(true)
  },60000)

  it('renews expired credentials exclusively across concurrent authorized requests',async()=>{
    const {TokenVault}=await import('../../supabase/functions/point/crypto')
    const keyId=process.env.TEST_POINT_TOKEN_KEY_ID ?? 'ci'
    const vault=new TokenVault({[keyId]:process.env.TEST_POINT_TOKEN_KEY ?? 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'},keyId)
    const businessId=owner.operator.business.id
    const row=JSON.parse(sql(`select jsonb_build_object('id',id,'tokens',tokens_ciphertext) from app_private.point_connections where business_id=${literal(businessId)}::uuid and status='connected';`))
    const token=await vault.open<Record<string,unknown>>(row.tokens,`mercadopago:${businessId}:sandbox`)
    token.expiresAt=new Date(Date.now()-1000).toISOString()
    const ciphertext=await vault.seal(token,`mercadopago:${businessId}:sandbox`)
    sql(`update app_private.point_connections set tokens_ciphertext=${literal(ciphertext)},expires_at=clock_timestamp()-interval '1 second' where id=${literal(row.id)}::uuid;`)
    const before=await stats()
    const results=await Promise.all([point(owner,{command:'verify_connection'}),point(owner,{command:'verify_connection'})])
    expect(results.some(r=>r.status===200)).toBe(true)
    expect(results.every(r=>r.status===200||r.error?.code==='POINT_REFRESH_BUSY')).toBe(true)
    expect((await stats()).refreshes-before.refreshes).toBe(1)
    data(await point(owner,{command:'verify_connection'}))
  },60000)

  it('uses separate PostgreSQL connections for double send and terminal competition, materializing once',async()=>{
    await control({scenario:'approved'})
    const first=await reserve(),second=await reserve()
    const request={command:'start' as const,operationId:randomUUID(),checkoutId:first.id}
    const replies=await Promise.all([point<PointCheckout>(owner,request),point<PointCheckout>(owner,request)])
    expect(data(replies[0]).attemptId).toBe(data(replies[1]).attemptId)
    expect(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:second.id})).toMatchObject({status:409,error:{code:'POINT_TERMINAL_BUSY'}})
    await Promise.all([worker(),worker()])
    const complete=await runUntil(first.id,c=>c.saleState==='materialized')
    expect(complete.state).toBe('approved_verified');expect(complete.sale?.paymentMethod).toBe('card_integrated')
    const replay=data(await point<PointCheckout>(owner,request));expect(replay.attemptId).toBe(complete.attemptId)
    expect(data(await point<PointCheckout>(owner,{command:'status',checkoutId:first.id})).sale?.id).toBe(complete.sale?.id)
    expect(Number(sql(`select count(*) from app_private.sales where id=${literal(complete.sale!.id)}::uuid;`))).toBe(1)
    expect(Number(sql(`select count(*) from app_private.point_fee_ledger where attempt_id=${literal(complete.attemptId!)}::uuid;`))).toBe(0)
    // The second prepared checkout remains recoverable and can begin only now.
    data(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:second.id}))
    await runUntil(second.id,c=>c.saleState==='materialized')
  },60000)

  it('does not dispatch a newly queued charge after disabling the business',async()=>{
    await control({scenario:'approved'})
    const checkout=await reserve(),before=await stats()
    const request={command:'start' as const,operationId:randomUUID(),checkoutId:checkout.id}
    const accepted=data(await point<PointCheckout>(owner,request))
    data(await point(owner,{command:'activate',enabled:false}))
    await worker()
    expect((await stats()).creates).toBe(before.creates)
    expect(data(await point<PointCheckout>(owner,request)).attemptId).toBe(accepted.attemptId)
    data(await point(owner,{command:'activate',enabled:true}))
    const paid=await runUntil(checkout.id,c=>c.saleState==='materialized')
    expect(paid.attemptId).toBe(accepted.attemptId)
    expect((await stats()).creates-before.creates).toBe(1)
  },60000)

  it('recovers a lost partial-refund response by the same request without a second refund',async()=>{
    await control({scenario:'approved'})
    const checkout=await reserve()
    data(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:checkout.id}))
    const paid=await runUntil(checkout.id,c=>c.saleState==='materialized'),before=await stats()
    const refund={command:'refund' as const,operationId:randomUUID(),checkoutId:checkout.id,amountCents:333,merchandiseCents:333,tipCents:0,reason:'Respuesta perdida sintética'}
    await control({scenario:'refund-timeout'})
    data(await point(owner,refund));await worker()
    expect(await point(owner,{...refund,operationId:randomUUID()})).toMatchObject({status:409,error:{code:'POINT_RESULT_UNCERTAIN'}})
    data(await point(owner,refund))
    await control({scenario:'approved'})
    const returned=await runUntil(checkout.id,c=>c.refundRequests.some(r=>r.operationId===refund.operationId && r.status==='confirmed'))
    expect(returned.refundedCents).toBe(333)
    expect(returned.sale?.id).toBe(paid.sale?.id)
    expect((await stats()).refunds-before.refunds).toBe(1)
  },60000)

  it('recovers a remote accepted charge with response loss and a dead worker without another charge',async()=>{
    const before=await stats();await control({scenario:'timeout-after'})
    const checkout=await reserve(),request={command:'start' as const,operationId:randomUUID(),checkoutId:checkout.id}
    data(await point(owner,request));await worker()
    const uncertain=data(await point<PointCheckout>(owner,{command:'status',checkoutId:checkout.id}))
    expect(uncertain.saleState).toBe('pending')
    expect(await pos(owner,{command:'record_checkout',operationId:randomUUID(),attemptId:checkout.checkout.id,expectedRevision:uncertain.checkout.revision,confirmed:true})).toMatchObject({status:409})
    expect(data(await point<PointCheckout>(owner,request)).attemptId).toBe(uncertain.attemptId)
    // Simulates process death after claiming: the next worker recovers an expired lease.
    sql(`update app_private.point_jobs set status='leased',lease_until=clock_timestamp()-interval '1 second',lease_token=gen_random_uuid() where attempt_id=${literal(uncertain.attemptId!)}::uuid and status='queued';`)
    await control({scenario:'approved'})
    const complete=await runUntil(checkout.id,c=>c.saleState==='materialized')
    expect(complete.sale).toBeTruthy();expect((await stats()).creates-before.creates).toBe(1)
  },60000)

  it('persists action_required as review and keeps recovery while collections are disabled',async()=>{
    await control({scenario:'action_required'})
    const checkout=await reserve();data(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:checkout.id}))
    const review=await runUntil(checkout.id,c=>c.state==='unknown_review')
    expect(review.sale).toBeNull()
    data(await point(owner,{command:'incident',operationId:randomUUID(),checkoutId:checkout.id,reason:'La terminal muestra confirmación pendiente'}))
    data(await point(owner,{command:'activate',enabled:false}))
    expect(data(await point<{checkouts:PointCheckout[]}>(owner,{command:'recover'})).checkouts.some(c=>c.id===checkout.id)).toBe(true)
    expect(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:checkout.id})).toMatchObject({status:200,data:{attemptId:review.attemptId}})
    // Authoritative remote evidence resolves the old attempt even when charging is off.
    await control({orderId:review.remoteOrderId,order:{status:'processed',status_detail:'processed',last_updated_date:new Date().toISOString(),transactions:{payments:[{...(await stats()).orders.find((o:{id:string})=>o.id===review.remoteOrderId).transactions.payments[0],status:'processed',status_detail:'accredited',reference_id:String(700000 + Number(review.remoteOrderId!.slice(3)))}],refunds:[]}}})
    sql(`update app_private.point_attempts set observed_at=clock_timestamp()-interval '10 minutes',updated_at=clock_timestamp()-interval '10 minutes' where id=${literal(review.attemptId!)}::uuid;`)
    await runUntil(checkout.id,c=>c.saleState==='materialized')
    data(await point(owner,{command:'activate',enabled:true}))
  },60000)

  it('deduplicates signed delayed webhooks, confirms refunds and rejects a global dashboard bypass',async()=>{
    await control({scenario:'approved'})
    const checkout=await reserve();data(await point(owner,{command:'start',operationId:randomUUID(),checkoutId:checkout.id}))
    const paid=await runUntil(checkout.id,c=>c.saleState==='materialized')
    const ts='1742505638683',requestId='independent-signature-fixture',id=paid.remoteOrderId!
    const signature=createHmac('sha256','simulator-webhook-secret').update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')
    const webhook=()=>fetch(`${url}/functions/v1/point-webhook?data.id=${id}&type=order`,{method:'POST',headers:{'content-type':'application/json',apikey:anon,'x-request-id':requestId,'x-signature':`ts=${ts},v1=${signature}`},body:JSON.stringify({type:'order',user_id:900001,live_mode:false,data:{id}})})
    expect((await webhook()).status).toBe(200);expect((await webhook()).status).toBe(200)
    const bad=await fetch(`${url}/functions/v1/point-webhook?data.id=${id}X&type=order`,{method:'POST',headers:{'content-type':'application/json',apikey:anon,'x-request-id':requestId,'x-signature':`ts=${ts},v1=${signature}`},body:JSON.stringify({type:'order',user_id:900001,live_mode:false,data:{id}})})
    expect(bad.status).toBe(401)
    const refund={command:'refund' as const,operationId:randomUUID(),checkoutId:checkout.id,amountCents:paid.totalCents,merchandiseCents:paid.totalCents,tipCents:0,reason:'Devolución sintética'}
    const refunds=await Promise.all([point(owner,refund),point(owner,{...refund,operationId:randomUUID()})])
    expect(refunds.map(r=>r.status).sort()).toEqual([200,409])
    const returned=await runUntil(checkout.id,c=>c.state==='refunded')
    expect(returned.sale?.id).toBe(paid.sale?.id);expect(returned.refundedCents).toBe(paid.totalCents)
    const from='2026-01-01',to='2027-01-01'
    expect(await point(owner,{command:'admin_report',from,to})).toMatchObject({status:403,error:{code:'POINT_ADMIN_DENIED'}})
    const report=data(await point<PointReport>(owner,{command:'merchant_report',from,to}))
    expect(report.settlementCents).toBeNull();expect(report.costsCents).toBeNull()
    expect(report.terminals.reduce((n,t)=>n+t.grossCents,0)).toBe(report.grossCents)
    expect(report.daily.reduce((n,d)=>n+d.refundCents,0)).toBe(report.refundCents)
  },60000)
})
